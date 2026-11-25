package harness

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"slices"
)

func (s *session) commitLocked(next api.Session, contexts ...context.Context) error {
	if s.rewindBlocked {
		return errRewindUnresolved
	}
	return s.commitSnapshotLocked(next, contexts...)
}

var errProvisionalSession = errors.New("session has not admitted its first input")

// Only admission and fork publication can start a persistent writer. Save the
// already staged setup with the new entries before making the state visible.
func (s *session) publishInitialLocked(next api.Session, contexts ...context.Context) error {
	if s.pendingStore == nil {
		return s.commitLocked(next, contexts...)
	}
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	return s.withErasureCheck(next, func() error {
		return s.commitCapacity(next, func() error {
			return s.traceCommit(next, true, contexts, func(ctx context.Context) error { return s.publishReservedInitialLocked(next, ctx) })
		})
	})
}

func (s *session) publishReservedInitialLocked(next api.Session, ctx context.Context) error {
	l, err := acquireNew(s.pendingStore, s.id)
	if err != nil {
		return s.stopWriterLocked(err)
	}
	s.lease = l
	s.watchWriter()
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	if err := saveHistory(ctx, l, next); err != nil {
		return s.stopWriterLocked(err)
	}
	s.pendingStore = nil
	s.publishLocked(next)
	s.provisional.Store(false)
	return nil
}

func (s *session) commitSnapshotLocked(next api.Session, contexts ...context.Context) error {
	return s.withErasureCheck(next, func() error {
		return s.commitCapacity(next, func() error {
			return s.traceCommit(next, s.lease != nil, contexts, func(ctx context.Context) error { return s.commitReservedSnapshotLocked(next, ctx) })
		})
	})
}

func (s *session) commitReservedSnapshotLocked(next api.Session, ctx context.Context) error {
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	if s.pendingStore != nil {
		nonSetup := func(e api.Entry) bool {
			switch e.Kind {
			case "setting", "actor.set", "actor.left", "plugins.set", "tenant", "limit", "subagent.bound":
				return false
			default:
				return true
			}
		}
		if len(next.Entries) < len(s.data.Entries) || slices.ContainsFunc(next.Entries[len(s.data.Entries):], nonSetup) {
			return errProvisionalSession
		}
		s.publishLocked(next)
		return nil
	}
	if s.lease != nil {
		if err := saveHistory(ctx, s.lease, next); err != nil {
			if s.rewindBlocked && !errors.Is(err, api.ErrWriterLost) && s.reconcileRewindCommit(next) {
				return nil
			}
			return s.stopWriterLocked(err)
		}
		s.provisional.Store(false)
	}
	s.publishLocked(next)
	return nil
}

func (s *session) publishLocked(next api.Session) {
	s.data = next
	if s.committed != nil {
		close(s.committed)
		s.committed = nil
	}
}

func (s *session) recordLocked(e api.Entry, writer string, advance bool, contexts ...context.Context) (api.Entry, error) {
	// Appending does not change published entries or session metadata. Clip
	// the prefix so staging cannot overwrite the published slice's backing array.
	next := s.data
	next.Entries = slices.Clip(next.Entries)
	e = appendEntry(&next, e, writer, advance)
	return e, s.commitLocked(next, contexts...)
}

func appendEntry(next *api.Session, e api.Entry, writer string, advance bool) api.Entry {
	if e.ID == "" {
		e.ID = api.ID()
	}
	e.Parent = next.Position
	e.Session = next.ID
	e.Time = worktime.Now().UTC()
	if (e.Kind != "job.start" && e.Kind != "job.end") || e.Writer == "" {
		e.Writer = writer
	}
	if e.Actor == "" && !e.OperatorAdmission {
		e.Actor = next.Actor
	}
	next.Entries = append(next.Entries, e)
	if advance {
		next.Position = e.ID
	}
	return e
}
func (c *client) Record(ctx context.Context, id string, e api.Entry) (api.Entry, error) {
	if e.Kind == "model.request" {
		if err := c.checkProviderErasure(ctx, id); err != nil {
			return e, err
		}
	}
	s, err := c.find(id)
	if err != nil {
		return e, err
	}
	s.mu.Lock()
	var admission api.Entry
	if e.Kind == "question.answer" {
		id, err := api.OperationEntry(ctx, s.data)
		if err != nil {
			s.mu.Unlock()
			return e, err
		}
		if id != "" {
			e.ID = id
		}
		a := api.Decode[api.Answer](e.Data)
		for _, prior := range s.data.LiveEntries() {
			if prior.Kind == "question.answer" && api.Decode[api.Answer](prior.Data).Request == a.Request {
				s.mu.Unlock()
				return e, api.ErrQuestionNotFound
			}
		}
	}
	if e.Kind == "job.end" && c.owner == "jobs" {
		e, admission, err = c.finishJobLocked(s, e, ctx)
		if err == nil {
			s.endJobSpan(e.Job, api.Decode[api.Job](e.Data).Outcome.Status)
		}
	} else {
		e, err = s.recordLocked(e, c.owner, true, telemetry.Step(telemetry.Session(ctx, id), e.Step))
		if err == nil && e.Kind == "job.start" {
			s.startJobSpan(telemetry.Session(ctx, id), e.Job)
		}
	}
	s.mu.Unlock()
	if err == nil {
		for _, entry := range []api.Entry{e, admission} {
			if entry.ID != "" {
				c.Emit(ctx, api.Event{Kind: "history.added", Session: id, Turn: entry.Turn, Step: entry.Step, Call: entry.Call, Actor: entry.Actor, Data: api.JSON(entry)})
			}
		}
	}
	return e, err
}

func (p *turnPorts) Record(ctx context.Context, e api.Entry) (api.Entry, error) {
	e.Turn = p.id
	e.Actor = p.actor
	if e.Kind == "tool.started" {
		call := api.Decode[api.Call](e.Data)
		sources, err := p.checkWaiting(ctx, call, false)
		if err != nil {
			return e, err
		}
		e.Copies = append(e.Copies, sources...)
		if len(sources) > 0 {
			p.s.mu.Lock()
			err := p.finalWaitingLocked(ctx, call, sources, false)
			if err == nil {
				w := api.WaitingApprovals(p.s.data)[call.ID]
				no := false
				e.SafeToRepeat = &no
				e.OpenWorld = &w.Question.Definition.External
				e.Wire = api.JSON(map[string]any{"data": map[string]any{"source": w.Question.Source, "definition": json.RawMessage(definitionJSON(*w.Question.Definition))}})
				e, err = p.s.recordLocked(e, p.c.owner, true, ctx)
			}
			p.s.mu.Unlock()
			if err == nil {
				p.Emit(ctx, api.Event{Kind: "history.added", Data: api.JSON(e)})
			}
			return e, err
		}
		if p.c.h.interfaceTools[call.Name] != nil {
			return e, errors.New("Interface start must be committed with its handoff")
		}
		if idx := slices.IndexFunc(p.tools, func(t api.Tool) bool { return t.Name == call.Name }); idx >= 0 {
			e.OpenWorld = &p.tools[idx].External
		}
	}
	if e.Kind == "turn.start" || (e.Kind == "tool.started" && p.id == "" && api.Decode[api.Call](e.Data).ParentCall == "") {
		var err error
		if e.Point, err = p.savePoint(ctx); err != nil {
			return e, err
		}
	}
	if e.Kind == "turn.end" && (p.c.h.SupportsWaitingApprovals() || len(p.c.h.interfaceTools) != 0 || len(api.InterfaceHandoffs(p.rawSnapshot())) != 0) {
		return p.recordInterfaceTurnEnd(ctx, e)
	}
	if e.Kind != "turn.start" {
		if e.Kind == "tool.result" && p.c.h.SupportsWaitingApprovals() {
			p.s.mu.Lock()
			if w := api.WaitingApprovals(p.s.data)[e.Call]; w != nil {
				if w.Terminal.ID != "" {
					p.s.mu.Unlock()
					return w.Terminal, nil
				}
				e.Copies = append(e.Copies, w.Request.ID)
				if w.Decision.ID != "" {
					e.Copies = append(e.Copies, w.Decision.ID)
				}
				e, err := p.s.recordLocked(e, p.c.owner, true, ctx)
				p.s.mu.Unlock()
				if err == nil {
					if w.Start.ID == "" && w.Question.ApprovalCall != nil {
						toolDisposition(ctx, *w.Question.ApprovalCall, api.Decode[api.ToolResult](e.Data).Status)
					}
					p.Emit(ctx, api.Event{Kind: "history.added", Data: api.JSON(e)})
				}
				return e, err
			}
			p.s.mu.Unlock()
		}
		if e.Kind == "input" {
			if e.InputID() == "" {
				e.InputRef = api.ID()
			}
			in := api.Input{ID: e.InputID(), Key: e.InputKey, Actor: e.Actor, When: "steer", Taken: "inTurn", ConnectionRights: p.input.ConnectionRights, Content: e.Content, Copies: e.Copies}
			accepted, err := p.c.Record(ctx, p.s.id, api.Entry{Kind: "input.accepted", InputRef: in.ID, Turn: p.id, Actor: e.Actor, Content: in.Content, Copies: in.Copies, Data: api.JSON(in)})
			if err != nil {
				return api.Entry{}, err
			}
			e.Copies = append(e.Copies, accepted.ID)
		}
		return p.c.Record(ctx, p.s.id, e)
	}
	start := api.Decode[api.TurnStart](e.Data)
	start.Model = p.model
	start.TraceContext = turnWire(ctx)
	// Publish the start and its input together. A crash cannot leave a start
	// whose input the next process is missing, even with an external Runtime.
	actual := p.s
	actual.mu.Lock()
	if p.input.Continuation != "" {
		start.ContinuesTurn = p.input.Continuation
		for _, source := range actual.data.Branch() {
			if source.ID == start.StartedBy.ID {
				e.Copies = append(e.Copies, source.ID)
				break
			}
		}
	} else if len(p.input.Calls) != 0 {
		// The nearest earlier turn that left one of these calls open owns
		// this continuation, even if the originating response was older.
		for i := len(actual.data.Entries) - 1; i >= 0; i-- {
			entry := actual.data.Entries[i]
			if entry.Kind == "turn.end" && slices.ContainsFunc(api.Decode[api.Outcome](entry.Data).Open, func(open api.Call) bool {
				return slices.ContainsFunc(p.input.Calls, func(call api.Call) bool { return call.ID == open.ID })
			}) {
				start.ContinuesTurn = entry.Turn
				break
			}
		}
	}
	e.Data = api.JSON(start)
	staged := &session{data: actual.data}
	e, err := staged.recordLocked(e, p.c.owner, true)
	var taken api.Entry
	if err == nil && p.input.ID != "" && len(p.input.Calls) == 0 {
		taken, err = staged.takeLocked(p.input, p.id)
	}
	if err == nil {
		err = actual.commitLocked(staged.data, ctx)
	}
	if errors.Is(err, api.ErrCapacity) && start.ContinuesTurn != "" {
		for waiter, origin := range actual.continuationWaiters {
			if origin == start.ContinuesTurn {
				delete(actual.continuationWaiters, waiter)
				close(waiter)
			}
		}
	}
	actual.mu.Unlock()
	if err == nil {
		for _, entry := range []api.Entry{e, taken} {
			if entry.ID != "" {
				p.Emit(ctx, api.Event{Kind: "history.added", Data: api.JSON(entry)})
			}
		}
	}
	return e, err
}
