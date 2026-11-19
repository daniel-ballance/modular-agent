package harness

import (
	"context"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
	"slices"
	"time"
)

var errRewindUnresolved = errors.New("project has an unresolved rewind; reopen the rewinding session to recover")

func (c *client) environmentPoints() (api.EnvironmentPoints, bool) {
	env, err := c.Get("working-environment")
	if err != nil {
		return nil, false
	}
	return api.Points(env.(api.WorkingEnvironment))
}

func (p *turnPorts) savePoint(ctx context.Context) (string, error) {
	points, ok := p.c.environmentPoints()
	if !ok {
		return "", nil
	}
	ctx = api.WithExecution(ctx, api.Execution{Session: p.s.id, Turn: p.id})
	point, err := points.SavePoint(ctx, p.s.project)
	if err != nil {
		return "", fmt.Errorf("save working environment point: %w", err)
	}
	if point == "" {
		return "", errors.New("working environment returned an empty point")
	}
	return point, nil
}

func (c *client) resetMoveProviders(ctx context.Context, id string) error {
	for _, capability := range c.All("provider.") {
		p := capability.(api.Provider)
		if !slices.ContainsFunc(p.Catalog(), func(m api.Model) bool { return m.Stateful }) {
			continue
		}
		discard, ok := p.(interface {
			Discard(context.Context, string) error
		})
		if !ok {
			return errors.New("the Provider cannot discard state")
		}
		if err := discard.Discard(ctx, id); err != nil {
			return fmt.Errorf("discard Provider state: %w", err)
		}
	}
	return nil
}

// Inspect stored journals before this host first admits project work. Once
// checked, the project gate serializes this host's registration and rewinds;
// operators must not use rewind across agents sharing a project.
func (c *client) checkStoredRewinds(project, opening string) error {
	if !c.h.checkedProjects[project] {
		if capability, err := c.Get("history"); err == nil {
			sessions, err := capability.(api.Store).List(project)
			if err != nil {
				return err
			}
			for _, saved := range sessions {
				pending, _, _, err := pendingRewind(saved.Entries)
				if err != nil || pending.Restore != nil {
					if owner := c.h.blockedProjects[project]; owner != "" && owner != saved.ID {
						return errors.New("project has more than one unresolved rewind")
					}
					if c.h.blockedProjects == nil {
						c.h.blockedProjects = map[string]string{}
					}
					c.h.blockedProjects[project] = saved.ID
				}
			}
		}
		if c.h.checkedProjects == nil {
			c.h.checkedProjects = map[string]bool{}
		}
		c.h.checkedProjects[project] = true
	}
	if owner := c.h.blockedProjects[project]; owner != "" && owner != opening {
		return errRewindUnresolved
	}
	return nil
}

// projectGate is held while checking who is hosted and while restoring files.
func (c *client) otherProjectSession(s *session) bool {
	c.h.mu.RLock()
	defer c.h.mu.RUnlock()
	for id, other := range c.h.sessions {
		if id != s.id && other.project == s.project {
			return true
		}
	}
	return false
}

func (c *client) holdRewind(s *session) {
	if c.h.blockedProjects == nil {
		c.h.blockedProjects = map[string]string{}
	}
	c.h.blockedProjects[s.project] = s.id
	s.rewindBlocked = true
}

func (c *client) clearRewind(s *session) {
	delete(c.h.blockedProjects, s.project)
	s.rewindBlocked = false
}

func (c *client) rewindLocked(ctx context.Context, s *session, target string, later []api.Entry, outside *[]string) error {
	points, ok := c.environmentPoints()
	if !ok {
		return errors.New("rewind refused: working environment does not support saved points")
	}
	if c.otherProjectSession(s) {
		return errors.New("rewind refused: another session uses the project")
	}
	if s.commands > 0 {
		return api.ErrMoveConflict
	}
	if pending, _ := recovery(s.data); pending != nil || len(externalRecovery(s.data)) > 0 {
		return api.ErrMoveConflict
	}
	// Jobs are session-level effects. Even an off-branch job cannot be undone
	// by a project snapshot. An end without a provable start is also unsafe.
	foundTarget := false
	olderJobs := map[string]bool{}
	activeJobs := map[string]bool{}
	for _, e := range s.data.Entries {
		kind := e.Kind
		if e.IsErased() {
			kind = e.OriginalKind
		}
		if foundTarget && (kind == "job.start" || kind == "job.end" && !olderJobs[e.Job]) {
			return errors.New("rewind refused: history records a job outside the working environment")
		}
		if kind == "job.start" {
			olderJobs[e.Job] = true
			activeJobs[e.Job] = true
		} else if kind == "job.end" {
			delete(activeJobs, e.Job)
		}
		foundTarget = foundTarget || e.ID == target
	}
	if len(activeJobs) > 0 {
		return api.ErrMoveConflict
	}
	ctx = api.WithExecution(ctx, api.Execution{Session: s.id})
	var earliest string
	var dispatched []string
	affected := map[string]bool{}
	for _, e := range later {
		kind := e.Kind
		if e.IsErased() {
			kind = e.OriginalKind
		}
		if kind == "tool.started" && e.Call != "" {
			if _, seen := affected[e.Call]; !seen {
				dispatched = append(dispatched, e.Call)
			}
			affected[e.Call] = affected[e.Call] || e.OpenWorld == nil || *e.OpenWorld
		}
		if kind != "turn.start" && (kind != "tool.started" || e.Turn != "") {
			continue
		}
		if e.Point == "" || e.IsErased() {
			return errors.New("rewind refused: history is missing a working environment point")
		}
		if err := points.CheckPoint(ctx, s.project, e.Point); err != nil {
			return fmt.Errorf("rewind refused: check point: %w", err)
		}
		if earliest == "" {
			earliest = e.Point
		}
	}
	for _, id := range dispatched {
		if affected[id] {
			*outside = append(*outside, id)
		}
	}
	if err := c.resetMoveProviders(ctx, s.id); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if earliest == "" {
		return c.movePosition(s, target, nil)
	}
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	previous := s.data.Position
	backup, err := points.SavePoint(ctx, s.project)
	if err != nil {
		return fmt.Errorf("rewind refused: save current files: %w", err)
	}
	if backup == "" || backup == earliest {
		return errors.New("rewind refused: working environment did not return a new undo point")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	intent := &api.RestoreIntent{Point: earliest, Undo: backup}
	c.holdRewind(s)
	if err := c.movePosition(s, target, intent); err != nil {
		return err
	}
	// The project is now blocked until a completion commits. Do not interrupt
	// the journal merely because the request that started it disconnected.
	restoreErr, journalErr := c.finishRewind(context.WithoutCancel(ctx), s, points, target, previous, intent, false)
	return errors.Join(restoreErr, journalErr)
}

func (c *client) movePosition(s *session, target string, restore *api.RestoreIntent) error {
	p := api.PositionChange{Restore: restore}
	if target != "" {
		p.To = &target
	}
	next := clone(s.data)
	next.Entries = append(next.Entries, api.Entry{ID: api.ID(), Parent: next.Position, Session: s.id, Kind: "position", Writer: c.owner, Actor: next.Actor, Time: time.Now().UTC(), Data: api.JSON(p)})
	next.Position = target
	if err := s.commitSnapshotLocked(next); err != nil {
		if !s.rewindBlocked || !s.reconcileRewindCommit(next) {
			return err
		}
	}
	s.last = recordedOutcome(s.data)
	return nil
}

// A save can fail after persisting. Only a verified writer can reconcile it.
// A fenced lease (including the HTTP client on uncertain append) requires a
// later open. Never guess at the journal from the pre-save in-memory state.
func (s *session) reconcileRewindCommit(expected api.Session) bool {
	if s.lease == nil {
		return false
	}
	writer, hasCheck := s.lease.(interface{ CheckWriter() error })
	if hasCheck && writer.CheckWriter() != nil {
		return false
	}
	got, err := s.lease.Load()
	if err != nil || (hasCheck && writer.CheckWriter() != nil) || got.Position != expected.Position || len(got.Entries) != len(expected.Entries) {
		return false
	}
	for i, e := range got.Entries {
		if !portable.Same(e, expected.Entries[i]) {
			return false
		}
	}
	s.data, s.writerFailed = expected, false
	return true
}

// The first error is the original move failure even if rollback completes.
// The second means the journal is still unresolved and must block reopening.
func (c *client) finishRewind(ctx context.Context, s *session, points api.EnvironmentPoints, target, previous string, intent *api.RestoreIntent, undo bool) (error, error) {
	if err := s.checkWriterLocked(); err != nil {
		return nil, err
	}
	var refused error
	if err := points.RestorePoint(ctx, s.project, intent.Point); err != nil {
		if undo {
			return nil, fmt.Errorf("restore pre-move files: %w", err)
		}
		refused = fmt.Errorf("rewind refused: restore working environment point: %w", err)
		compensation := &api.RestoreIntent{Point: intent.Undo, Undo: intent.Point}
		if err := c.movePosition(s, previous, compensation); err != nil {
			return refused, err
		}
		if err := s.checkWriterLocked(); err != nil {
			return refused, err
		}
		if err := points.RestorePoint(ctx, s.project, compensation.Point); err != nil {
			return refused, fmt.Errorf("restore pre-move files: %w", err)
		}
		target = previous
	}
	if err := c.movePosition(s, target, nil); err != nil {
		return refused, err
	}
	c.clearRewind(s)
	return refused, nil
}

func (c *client) recoverRewind(ctx context.Context, s *session) error {
	pending, previous, undo, err := pendingRewind(s.data.Entries)
	if err != nil {
		c.holdRewind(s)
		return fmt.Errorf("rewind recovery: %w", err)
	}
	if pending.Restore == nil {
		c.clearRewind(s)
		return nil
	}
	c.holdRewind(s)
	if c.otherProjectSession(s) {
		return errors.New("rewind recovery refused: another session uses the project")
	}
	points, ok := c.environmentPoints()
	if !ok {
		return errors.New("rewind recovery: working environment does not support saved points")
	}
	ctx = api.WithExecution(ctx, api.Execution{Session: s.id})
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	if err := c.resetMoveProviders(ctx, s.id); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// A successful rollback reopens at the old head. The failed move itself
	// has already lost its caller; only an unresolved journal fails the open.
	_, err = c.finishRewind(context.WithoutCancel(ctx), s, points, pending.Target(), previous, pending.Restore, undo)
	return err
}

// Read the journal in append order, not from the selected branch. Only a
// matching completion clears it; an unrelated position or legacy failure does
// not establish which files are present. Invalid progress fails closed.
func pendingRewind(entries []api.Entry) (api.PositionChange, string, bool, error) {
	var pending api.PositionChange
	var previous, head string
	seen := make(map[string]api.Entry, len(entries))
	undo := false
	for _, e := range entries {
		if e.Kind != "position" || e.IsErased() {
			if pending.Restore != nil || e.OriginalKind == "position" {
				return pending, previous, undo, errors.New("rewind journal is interrupted by an unrelated record")
			}
			head = e.ID
			seen[e.ID] = e
			continue
		}
		p, err := api.ReadPosition(e.Data)
		if err != nil {
			return pending, previous, undo, err
		}
		if p.Failed {
			return pending, previous, undo, errors.New("legacy failed position does not establish the state of project files")
		}
		if pending.Restore == nil {
			if p.Restore != nil {
				// The initial intent must move from the current head to
				// a quiescent ancestor. Only compensation can go back
				// to a head no longer on the selected branch.
				id := head
				for n := 0; id != "" && id != p.Target() && n < len(seen); n++ {
					id = seen[id].Parent
				}
				target, ok := seen[id]
				if head != e.Parent || id != p.Target() || !ok ||
					(target.Turn != "" && target.Kind != "turn.end" && target.OriginalKind != "turn.end") {
					return pending, previous, undo, errors.New("invalid initial rewind intent")
				}
			}
			pending, previous, undo, head = p, e.Parent, false, p.Target()
			continue
		}
		if e.Parent == pending.Target() {
			if p.Restore == nil && p.Target() == pending.Target() {
				pending = api.PositionChange{}
				head = p.Target()
				continue
			}
			if !undo && p.Restore != nil && p.Target() == previous && p.Restore.Point == pending.Restore.Undo && p.Restore.Undo == pending.Restore.Point {
				pending, undo = p, true
				continue
			}
		}
		return pending, previous, undo, errors.New("invalid rewind journal progression")
	}
	return pending, previous, undo, nil
}
