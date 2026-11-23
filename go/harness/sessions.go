package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"go.opentelemetry.io/otel/trace"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type session struct {
	interfaceConnections []*InterfaceConnection
	interfaceSpans       map[string]trace.SpanContext
	interfaceParents     map[string]*telemetry.Wire
	interfaceUnreleased  map[string]bool
	interfaceTimer       worktime.Timer
	interfaceReports     sync.Mutex
	queuedContinuations  map[string]bool
	jobSpans             map[string]context.Context
	id                   string // immutable, safe for event routing while snapshots change
	project              string // immutable canonical workspace for rewind exclusion
	tenant               string // immutable capacity scope for output
	rewindBlocked        bool
	commandCancels       map[*commandCancellation]struct{}
	commandBytes         int64
	mu                   sync.Mutex
	data                 api.Session
	storageCharges       []int64 // encoded sizes for data.Entries, under mu
	lease                api.Lease
	pendingStore         api.Store // no persistent writer until first admission or fork publication
	provisional          atomic.Bool
	erasureTombstones    atomic.Pointer[map[string]bool]
	h                    *Harness
	interrupted          chan struct{}
	interruptEmitted     chan struct{}
	writerWatchDone      chan struct{}
	writerFailure        error
	running, closing     bool
	stopping             bool // a detach is already settling work and closing the lease
	opening              bool // job reports during session.start wait for recovery setup
	cancel               context.CancelCauseFunc
	done                 chan struct{}
	queue                []api.Input
	activeActor          string
	steeringClosed       bool
	activeInput          api.Input
	last                 api.Outcome
	resume               *api.Entry
	external             []api.Call
	responseClaim        *api.Entry
	transferredInput     string
}

func clone[T any](v T) T {
	var out T
	if err := json.Unmarshal(api.JSON(v), &out); err != nil {
		panic(err)
	}
	return out
}
func (c *client) find(id string) (*session, error) {
	c.h.mu.RLock()
	defer c.h.mu.RUnlock()
	s, ok := c.h.sessions[id]
	if !ok {
		return nil, errors.New("session not open")
	}
	return s, nil
}
func (c *client) checkProject(project string) error {
	if v, err := c.Get("project-policy"); err == nil {
		return v.(interface{ CheckProject(string) error }).CheckProject(project)
	}
	return nil
}
func (c *client) New(ctx context.Context, project string) (string, error) {
	return c.NewInTenant(ctx, project, "")
}

func (c *client) NewInTenant(ctx context.Context, project, tenant string) (string, error) {
	if err := c.checkTenant(tenant); err != nil {
		return "", err
	}
	return c.newSession(ctx, project, tenant, nil, false, nil, nil)
}

func (c *client) NewForHost(ctx context.Context, project, tenant string, host api.Actor) (string, error) {
	if err := c.checkTenant(tenant); err != nil {
		return "", err
	}
	return c.newSession(ctx, project, tenant, nil, false, &host, nil)
}

func (c *client) NewEmbedded(ctx context.Context, project, tenant string, actors []api.Actor) (string, error) {
	if err := c.checkTenant(tenant); err != nil {
		return "", err
	}
	return c.newSession(ctx, project, tenant, nil, false, nil, actors)
}

func (c *client) newSession(ctx context.Context, project, tenant string, limit *[]string, forking bool, host *api.Actor, initial []api.Actor) (idOut string, errOut error) {
	ctx, span := telemetry.Start(ctx, "modular_agent.session.open", trace.WithAttributes(telemetry.String("modular_agent.session.operation", "new")))
	defer func() {
		if idOut != "" {
			span.SetAttributes(telemetry.String("gen_ai.conversation.id", idOut))
		}
		telemetry.Finish(span, errOut)
	}()
	if err := c.seedCapacity(); err != nil {
		return "", err
	}
	project, err := filepath.Abs(project)
	if err == nil {
		project, err = filepath.EvalSymlinks(project)
	}
	if err != nil {
		return "", err
	}
	if err = c.checkProject(project); err != nil {
		return "", err
	}
	if !api.SessionScopeAllows(ctx, project, tenant) {
		return "", api.ErrAuthority
	}
	info, err := os.Stat(project)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("project is not a folder")
	}
	settings, provided := api.SessionSettings(ctx)
	if v, err := c.Get("configuration"); !provided && err == nil {
		settings, err = v.(api.Configuration).Settings(project)
		if err != nil {
			return "", err
		}
	}
	if host == nil && !forking && tenant != "" && !slices.Contains(c.h.tenants[tenant].Rights, "input") {
		return "", api.ErrAuthority
	}
	id := api.ID()
	if settings.Approval == "" {
		settings.Approval = "off"
	}
	s := c.newSessionState(id, project)
	s.tenant = tenant
	s.data = api.Session{Version: 1, ID: id, Project: project, Settings: settings, Actor: c.h.localActor, Tenant: tenant, Limit: limit}
	if host != nil {
		s.data.Actor = host.ID
	}
	c.h.mu.RLock()
	s.data.Plugins = append([]string(nil), c.h.order...)
	c.h.mu.RUnlock()
	if tenant != "" && !forking {
		if _, err = s.recordLocked(api.Entry{Kind: "tenant", Data: api.JSON(tenant)}, "harness", true); err != nil {
			return "", err
		}
	}
	if host != nil {
		if err := s.joinHostLocked(*host); err != nil {
			return "", err
		}
	} else if !forking && c.h.localActor != "local-user" {
		// The portable store reconstructs the actor from records, not the snapshot.
		local := api.Actor{ID: s.data.Actor, Kind: "user", Rights: slices.Clone(api.Rights)}
		if err := s.joinHostLocked(local); err != nil {
			return "", err
		}
	}
	for _, actor := range initial {
		if err := s.joinActorLocked("", actor, "harness"); err != nil {
			return "", err
		}
	}
	if _, err = s.recordLocked(api.Entry{Kind: "plugins.set", Data: api.JSON(s.data.Plugins)}, "harness", true); err != nil {
		return "", err
	}
	if v, err := c.Get("history"); err == nil {
		store := v.(api.Store)
		s.provisional.Store(true)
		if c.h.deferHistory {
			s.pendingStore = store
		} else {
			s.lease, err = acquireNew(store, id)
			if err != nil {
				return "", err
			}
		}
	}
	if err = c.registerNew(s, s.pendingStore == nil && (host != nil || tenant != "" && !forking)); err != nil {
		if s.lease != nil {
			_ = s.lease.Close()
		}
		return "", err
	}
	if _, err = c.h.API().Invoke(ctx, "session.prepare", api.SessionPrepare{Session: clone(s.data)}); err != nil {
		_ = c.CloseSession(id)
		return "", err
	}
	if _, err = c.h.API().Invoke(ctx, "session.start", clone(s.data)); err != nil {
		_ = c.CloseSession(id)
		return "", err
	}
	_, _ = c.h.API().Invoke(ctx, "session.ready", clone(s.data))
	c.Emit(ctx, api.Event{Kind: "session.ready", Session: id, Data: api.JSON(map[string]any{"sessionId": id})})
	return id, nil
}
func acquireNew(store api.Store, id string) (api.Lease, error) {
	if fresh, ok := store.(interface {
		AcquireNew(string) (api.Lease, error)
	}); ok {
		return fresh.AcquireNew(id)
	}
	return store.Acquire(id)
}

func (c *client) registerNew(s *session, commit bool) error {
	c.h.projectGate.Lock()
	defer c.h.projectGate.Unlock()
	if err := c.checkStoredRewinds(s.project, ""); err != nil {
		return err
	}
	if commit {
		if err := s.commitLocked(s.data); err != nil {
			return err
		}
	}
	c.h.mu.Lock()
	c.h.sessions[s.id] = s
	c.h.mu.Unlock()
	s.watchWriter()
	return nil
}

func (c *client) Open(ctx context.Context, id string) error {
	return c.open(ctx, id, nil)
}

func (c *client) OpenForHost(ctx context.Context, id string, host api.Actor) error {
	return c.open(ctx, id, &host)
}

func (c *client) open(ctx context.Context, id string, host *api.Actor) (errOut error) {
	ctx, span := telemetry.Start(telemetry.Session(ctx, id), "modular_agent.session.open", trace.WithAttributes(telemetry.String("modular_agent.session.operation", "load")))
	defer func() { telemetry.Finish(span, errOut) }()
	if err := c.seedCapacity(); err != nil {
		return err
	}
	v, err := c.Get("history")
	if err != nil {
		return err
	}
	lease, err := acquireHistory(ctx, v.(api.Store), id)
	if err != nil {
		return err
	}
	snap, err := loadHistory(ctx, lease)
	if err != nil {
		_ = lease.Close()
		return err
	}
	if err = c.checkProject(snap.Project); err != nil {
		_ = lease.Close()
		return err
	}
	if !api.SessionScopeAllows(ctx, snap.Project, snap.Tenant) {
		_ = lease.Close()
		return api.ErrAuthority
	}
	if err = c.checkTenant(snap.Tenant); err != nil {
		_ = lease.Close()
		return err
	}
	if host != nil && (!api.ConnectionAllows(ctx, "watch") || !c.DiscoverForHost(snap, *host)) {
		_ = lease.Close()
		return api.ErrAuthority
	}
	savedApproval := snap.Settings.Approval
	if conf, err := c.Get("configuration"); err == nil {
		if defaults, err := conf.(api.Configuration).Settings(snap.Project); err == nil {
			snap.Settings = turnSettings(defaults, snap.Settings)
		}
	}
	snap.Settings.Model = c.h.currentModel(snap.Settings.Model)
	project, err := filepath.EvalSymlinks(snap.Project)
	if err != nil {
		_ = lease.Close()
		return err
	}
	s := c.newSessionState(id, project)
	s.tenant = snap.Tenant
	s.data, s.lease, s.last, s.opening = snap, lease, recordedOutcome(snap), true
	if err = s.reconcileErasureLocked(); err != nil {
		_ = lease.Close()
		return err
	}
	snap = s.data
	if err = c.registerOpen(ctx, s, host, savedApproval); err != nil {
		_ = lease.Close()
		return err
	}
	if _, err = s.invokeWithErasureView(ctx, "session.prepare", snap, api.SessionPrepare{Session: clone(snap), Reopened: true}); err != nil {
		_ = c.StopSession(id)
		return err
	}
	if _, err = s.invokeWithErasureView(ctx, "session.recoverQuestions", snap, clone(snap)); err != nil {
		_ = c.StopSession(id)
		return err
	}
	if err = c.recoverNested(s); err != nil {
		_ = c.StopSession(id)
		return err
	}
	s.mu.Lock()
	err = c.repairJobReportsLocked(s)
	snap = clone(s.data)
	s.mu.Unlock()
	if err != nil {
		_ = c.StopSession(id)
		return err
	}
	_, err = s.invokeWithErasureView(api.WithReopenedSession(ctx), "session.start", snap, clone(snap))
	if err != nil {
		_ = c.CloseSession(id)
		return err
	}
	s.mu.Lock()
	s.opening = false
	if err = c.h.recoverInterfaceLocked(s); err != nil {
		s.mu.Unlock()
		_ = c.StopSession(id)
		return err
	}
	s.resume, s.queue = recovery(s.data)
	// Proposals are available through the record, not the running turn's
	// queue; a cancel must not hand back an unreleased proposal.
	s.queue = slices.DeleteFunc(s.queue, parked)
	if c.h.handBackOnOpen && len(s.queue) > 0 {
		ids := make([]string, 0, len(s.queue))
		s.queue = slices.DeleteFunc(s.queue, func(in api.Input) bool {
			if in.Job != "" && !c.h.parkJobReports {
				return false
			}
			ids = append(ids, in.ID)
			return true
		})
		if len(ids) > 0 {
			if _, err = s.recordLocked(api.Entry{Kind: "input.returned", Data: api.JSON(ids)}, "harness", true); err != nil {
				s.mu.Unlock()
				_ = c.StopSession(id)
				return err
			}
		}
	}
	s.external = externalRecovery(s.data)
	c.h.queueInterfaceContinuationsLocked(s)
	nextInput := runnableInput(s.queue)
	if s.resume != nil || nextInput >= 0 || len(s.external) > 0 {
		in := api.Input{Actor: snap.Actor}
		if s.resume == nil && len(s.external) == 0 {
			in = s.queue[nextInput]
			s.queue = slices.Delete(s.queue, nextInput, nextInput+1)
		}
		s.running = true
		s.activeActor, s.activeInput = in.Actor, in
		s.done = make(chan struct{})
		runCtx, cancel := context.WithCancelCause(context.Background())
		s.cancel = cancel
		go c.h.run(runCtx, s, in)
	}
	s.mu.Unlock()
	_, err = c.h.API().Invoke(ctx, "session.ready", snap)
	if err == nil {
		c.Emit(ctx, api.Event{Kind: "session.ready", Session: id, Data: api.JSON(map[string]any{"sessionId": id, "reopened": true})})
	}
	return err
}

func (c *client) registerOpen(ctx context.Context, s *session, host *api.Actor, savedApproval string) error {
	c.h.projectGate.Lock()
	defer c.h.projectGate.Unlock()
	if err := c.checkStoredRewinds(s.project, s.id); err != nil {
		return err
	}
	c.h.mu.RLock()
	_, alreadyOpen := c.h.sessions[s.id]
	active := append([]string(nil), c.h.order...)
	c.h.mu.RUnlock()
	if alreadyOpen {
		return errors.New("session already open")
	}
	if host != nil {
		// Check the connection before touching files, but don't append a grant
		// between a rewind intent and its completion.
		view := clone(s.data)
		if !recordedHost(view, host.ID) {
			view.Actors = actors(view)
			view.Actors[host.ID] = *host
		}
		if !c.authorized(view, host.ID, "watch") {
			return errors.New("open forbidden")
		}
	}
	if err := c.recoverRewind(ctx, s); err != nil {
		return err
	}
	if host != nil {
		s.data.Settings.Approval = api.ReopenedApproval(savedApproval)
		if err := s.joinHostLocked(*host); err != nil {
			return err
		}
	}
	if !samePlugins(s.data.Plugins, active) || !slices.ContainsFunc(s.data.Entries, func(e api.Entry) bool { return e.Kind == "plugins.set" }) {
		s.data.Plugins = active
		if _, err := s.recordLocked(api.Entry{Kind: "plugins.set", Data: api.JSON(active)}, "harness", true); err != nil {
			return err
		}
	}
	c.h.mu.Lock()
	c.h.sessions[s.id] = s
	c.h.mu.Unlock()
	s.watchWriter()
	return nil
}

func (c *client) List(project string) ([]api.Session, error) {
	if project != "" {
		var err error
		project, err = filepath.Abs(project)
		if err != nil {
			return nil, err
		}
	}
	if v, err := c.Get("history"); err == nil {
		rows, err := v.(api.Store).List(project)
		if remote := api.RemoteRegistry(v); err == nil && remote != nil {
			return listRemoteViews(remote, rows)
		}
		return rows, err
	}
	c.h.mu.RLock()
	var sessions []*session
	for _, s := range c.h.sessions {
		sessions = append(sessions, s)
	}
	c.h.mu.RUnlock()
	var out []api.Session
	for _, s := range sessions {
		s.mu.Lock()
		if project == "" || s.data.Project == project {
			out = append(out, clone(s.data))
		}
		s.mu.Unlock()
	}
	return out, nil
}
func (c *client) Snapshot(id string) (api.Session, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Session{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileErasureLocked(); err != nil {
		return api.Session{}, err
	}
	snap := copySession(s.data)
	if err := s.admitErasureView(snap); err != nil {
		return api.Session{}, err
	}
	return snap, nil
}
func (c *client) View(ctx context.Context, id string) (api.Session, error) {
	return c.view(ctx, id, true)
}

// ViewForOutput applies the native view policy before the Interface shapes
// the entries or reply that the remote gate will see.
func (c *client) ViewForOutput(ctx context.Context, id string) (api.Session, error) {
	return c.view(ctx, id, false)
}

func (c *client) view(ctx context.Context, id string, gateRemote bool) (api.Session, error) {
	if !api.ConnectionAllows(ctx, "watch") || !c.Authorize(id, api.Acting(ctx), "watch") {
		return api.Session{}, errors.New("watch refused")
	}
	epoch, err := c.ErasureEpoch(id)
	if err != nil {
		return api.Session{}, err
	}
	snap, err := c.Snapshot(id)
	if err != nil {
		return snap, err
	}
	for i, entry := range snap.Entries {
		snap.Entries[i] = portable.PublicEntry(entry)
	}
	event := api.Event{Kind: "history.view", Session: id, Data: api.JSON(snap)}
	if gateRemote {
		out, err := c.OutputValue(ctx, event)
		if err != nil {
			return api.Session{}, err
		}
		if got, err := c.ErasureEpoch(id); err != nil || got != epoch {
			return api.Session{}, api.ErrErasureUnavailable
		}
		return api.Decode[api.Session](out.Data), nil
	}
	out, err := c.output(ctx, event)
	if err != nil || out.Hold {
		return api.Session{}, api.ErrOutputWithheld
	}
	if got, err := c.ErasureEpoch(id); err != nil || got != epoch {
		return api.Session{}, api.ErrErasureUnavailable
	}
	return api.Decode[api.Session](out.Event.Data), nil
}

// commitLocked stages a new state and publishes only after persistence succeeds.
func (s *session) commitLocked(next api.Session, contexts ...context.Context) error {
	if s.rewindBlocked {
		return errRewindUnresolved
	}
	return s.commitSnapshotLocked(next, contexts...)
}

var errProvisionalSession = errors.New("session has not admitted its first input")

func isSetup(e api.Entry) bool {
	switch e.Kind {
	case "setting", "actor.set", "actor.left", "plugins.set", "tenant", "limit", "subagent.bound":
		return true
	default:
		return false
	}
}

func startsLegacyHistory(e api.Entry) bool { return !isSetup(e) || e.Kind == "subagent.bound" }

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
	s.pendingStore, s.data = nil, next
	s.provisional.Store(false)
	return nil
}

func (s *session) commitSnapshotLocked(next api.Session, contexts ...context.Context) error {
	return s.withErasureCheck(next, func() error {
		return s.commitCapacity(next, func() error {
			return s.traceCommit(next, s.savesSnapshot(next), contexts, func(ctx context.Context) error { return s.commitReservedSnapshotLocked(next, ctx) })
		})
	})
}

func (s *session) savesSnapshot(next api.Session) bool {
	return s.pendingStore == nil && s.lease != nil && (s.h.deferHistory || next.ForkedFrom != "" || slices.ContainsFunc(next.Entries, startsLegacyHistory))
}

func (s *session) commitReservedSnapshotLocked(next api.Session, contexts ...context.Context) error {
	ctx := firstContext(contexts)
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	if s.pendingStore != nil {
		if len(next.Entries) < len(s.data.Entries) || slices.ContainsFunc(next.Entries[len(s.data.Entries):], func(e api.Entry) bool { return !isSetup(e) }) {
			return errProvisionalSession
		}
		s.data = next
		return nil
	}
	// Outside the public persistent lifecycle, keep the original lazy
	// save rule. An attached public persistent lease saves all changes.
	if s.savesSnapshot(next) {
		if err := saveHistory(ctx, s.lease, next); err != nil {
			if s.rewindBlocked && !errors.Is(err, api.ErrWriterLost) && s.reconcileRewindCommit(next) {
				return nil
			}
			return s.stopWriterLocked(err)
		}
		s.provisional.Store(false)
	}
	s.data = next
	return nil
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
func (c *client) Move(ctx context.Context, id, target string, rewind bool) error {
	_, err := c.MoveDetails(ctx, id, target, rewind)
	return err
}

func (c *client) MoveDetails(ctx context.Context, id, target string, rewind bool) ([]string, error) {
	var outside []string
	err := c.move(ctx, id, target, rewind, &outside)
	return outside, err
}

func (c *client) move(ctx context.Context, id, target string, rewind bool, outside *[]string) error {
	if rewind {
		c.h.projectGate.Lock()
		defer c.h.projectGate.Unlock()
	}
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !c.authorizedBy(s.data, ctx, "settings") {
		return errors.New("move refused")
	}
	if s.pendingStore != nil {
		return errProvisionalSession
	}
	if s.rewindBlocked {
		return errRewindUnresolved
	}
	if err = s.checkWriterLocked(); err != nil {
		return err
	}
	if s.running || s.opening || s.closing || len(s.queue) > 0 || unfinished(s.data) {
		return api.ErrMoveConflict
	}
	branch := s.data.Branch()
	i := slices.IndexFunc(branch, func(e api.Entry) bool { return e.ID == target })
	if i == -1 || (branch[i].Turn != "" && branch[i].Kind != "turn.end" && branch[i].OriginalKind != "turn.end") {
		return api.ErrMoveConflict
	}
	candidate := clone(s.data)
	candidate.Position = target
	if unfinished(candidate) {
		return api.ErrMoveConflict
	}
	if pending, _ := recovery(candidate); pending != nil {
		return api.ErrMoveConflict
	}
	if rewind {
		return c.rewindLocked(ctx, s, target, branch[i+1:], outside)
	}
	if err := c.resetMoveProviders(ctx, s.id); err != nil {
		return err
	}
	return c.movePosition(s, target, nil)
}
func (c *client) Fork(ctx context.Context, id, target string) (string, error) {
	s, err := c.find(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if err := s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return "", err
	}
	snap := s.data
	running := s.running
	allowed := c.authorizedBy(snap, ctx, "input") && c.authorizedBy(snap, ctx, "settings")
	s.mu.Unlock()
	if !allowed {
		return "", api.ErrAuthority
	}
	if running {
		return "", errors.New("cancel turn before forking")
	}
	if unfinished(snap) {
		return "", errors.New("settle calls and jobs before forking")
	}
	if target != "" {
		snap.Position = target
	}
	found := snap.Position == ""
	for _, e := range snap.Entries {
		if e.ID == snap.Position {
			found = true
		}
	}
	if !found {
		return "", errors.New("unknown fork position")
	}
	if unfinished(snap) {
		return "", errors.New("fork target has unfinished calls or jobs")
	}
	if pending, _ := recovery(snap); pending != nil {
		return "", errors.New("fork target is inside a turn; choose a completed boundary")
	}
	fork, err := c.newSession(ctx, snap.Project, snap.Tenant, snap.Limit, true, nil, nil)
	if err != nil {
		return "", err
	}
	s, _ = c.find(fork)
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	next.Settings = snap.Settings
	next.Actors = clone(actors(snap))
	next.Actor = snap.Actor
	next.Parent, next.ParentActor, next.Ceiling, next.Depth = snap.Parent, snap.ParentActor, snap.Ceiling, snap.Depth
	next.ForkedFrom = id + ":" + snap.Position
	next.Entries = nil
	parent := ""
	mapping := map[string]string{}
	for _, e := range snap.Branch() {
		if e.IsErased() || e.Kind == "position" || e.Kind == "tenant" || e.Kind == "limit" || e.Kind == "erasure" || e.Kind == telemetry.TurnTrace || e.Kind == api.InterfaceHandoffKind {
			continue
		}
		if e.Kind == "turn.start" {
			start := api.Decode[api.TurnStart](e.Data)
			start.TraceContext = nil
			e.Data = api.JSON(start)
		}
		source := e.ID
		e.ID = api.ID()
		mapping[source] = e.ID
		e.Session = fork
		e.Parent = parent
		e.Copies = []string{source}
		next.Entries = append(next.Entries, e)
		parent = e.ID
	}
	appendSetup := func(kind string, data any) {
		e := api.Entry{ID: api.ID(), Parent: parent, Session: fork, Kind: kind, Actor: api.Acting(ctx), Writer: "harness", Time: time.Now().UTC(), Data: api.JSON(data)}
		next.Entries, parent = append(next.Entries, e), e.ID
	}
	if snap.Tenant != "" {
		appendSetup("tenant", snap.Tenant)
	}
	seen := map[string]bool{}
	for _, e := range snap.Entries {
		if e.Kind == "actor.left" {
			who := api.Decode[string](e.Data)
			if _, stillMember := next.Actors[who]; !stillMember && !seen[who] {
				appendSetup("actor.left", who)
				seen[who] = true
			}
		}
	}
	actorIDs := make([]string, 0, len(next.Actors))
	for who := range next.Actors {
		actorIDs = append(actorIDs, who)
	}
	sort.Strings(actorIDs)
	for _, who := range actorIDs {
		appendSetup("actor.set", next.Actors[who])
	}
	appendSetup("setting", next.Settings)
	if snap.Limit != nil {
		appendSetup("limit", *snap.Limit)
	}
	appendSetup("plugins.set", next.Plugins)
	next.Position = parent
	// Metadata belongs to its plugin. Invoke outside the session lock.
	s.mu.Unlock()
	var transformed any
	hookErr := c.admitForkView(snap)
	if hookErr == nil {
		transformed, hookErr = c.h.API().Invoke(ctx, "session.fork", api.Forked{Session: next, Mapping: mapping})
	}
	s.mu.Lock()
	if hookErr == nil {
		next = transformed.(api.Forked).Session
		hookErr = s.publishInitialLocked(next)
	}
	if hookErr != nil {
		s.mu.Unlock()
		_ = c.CloseSession(fork)
		s.mu.Lock()
		return "", hookErr
	}
	return fork, nil
}
func recordedInputID(e api.Entry) string {
	switch e.Kind {
	case "input":
		return e.InputID()
	case "input.accepted":
		return api.Decode[api.Input](e.Data).ID
	}
	return ""
}

func recordedOutcome(snap api.Session) api.Outcome {
	var out api.Outcome
	for _, entry := range snap.Branch() {
		if entry.Kind == "turn.end" {
			out = api.Decode[api.Outcome](entry.Data)
		}
	}
	return out
}

// SettingsDuringTurn describes the effect of supported model and approval settings.
func (c *client) SettingsDuringTurn() string {
	if c.h.refuseSettings {
		return "refused"
	}
	return "nextTurn"
}

func (c *client) SetSettings(ctx context.Context, id string, settings api.Settings) error {
	if !api.ConnectionAllows(ctx, "settings") || !c.Authorize(id, api.Acting(ctx), "settings") {
		return errors.New("settings refused")
	}
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		if c.h.refuseSettings {
			return api.ErrSettingsBusy
		}
		// Selection and approval changes apply to the next turn. The running
		// turn retains its recorded settings, including across recovery.
		before, after := s.data.Settings, settings
		before.Model, before.Thinking, before.Approval = after.Model, after.Thinking, after.Approval
		before.ModelTools = after.ModelTools
		if before != after {
			return errors.New("non-model settings change applies between turns only")
		}
	}
	next := clone(s.data)
	next.Settings = settings
	e := api.Entry{ID: api.ID(), Parent: next.Position, Session: id, Actor: api.Acting(ctx), Writer: c.owner, Time: time.Now().UTC(), Kind: "setting", Data: api.JSON(settings)}
	next.Entries = append(next.Entries, e)
	next.Position = e.ID
	return s.commitLocked(next)
}
func (c *client) Submit(ctx context.Context, id string, in api.Input) (receipt api.Receipt, errOut error) {
	ctx, span := telemetry.Start(telemetry.Session(ctx, id), "modular_agent.input.admit")
	defer func() {
		if receipt.ID != "" {
			span.SetAttributes(telemetry.String("modular_agent.input.id", receipt.ID))
		}
		telemetry.Finish(span, errOut)
	}()
	in.ConnectionRights = api.ConnectionRights(ctx)
	if in.Job != "" {
		return api.Receipt{}, api.ErrJobReportRefused
	}
	if strings.HasPrefix(in.Key, "job:") || strings.HasPrefix(in.Actor, "job:") || strings.HasPrefix(api.Acting(ctx), "job:") {
		return api.Receipt{}, errors.New("job report keys and actors are reserved")
	}
	s, err := c.find(id)
	if err != nil {
		return api.Receipt{}, err
	}
	if in.Actor == "" {
		in.Actor = api.Acting(ctx)
	}
	if in.ID == "" {
		in.ID = api.ID()
	}
	if in.When == "" {
		in.When = "now"
	}
	s.mu.Lock()
	if err := s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return api.Receipt{}, err
	}
	if s.rewindBlocked {
		s.mu.Unlock()
		return api.Receipt{}, errRewindUnresolved
	}
	if !api.SessionScopeAllows(ctx, s.data.Project, s.data.Tenant) || !c.canAdmit(s.data, in) {
		s.mu.Unlock()
		return api.Receipt{}, api.ErrAuthority
	}
	if err := s.checkWriterLocked(); err != nil {
		s.mu.Unlock()
		return api.Receipt{}, err
	}
	if !api.InputWatermarkMatches(ctx, s.data) {
		s.mu.Unlock()
		return api.Receipt{}, api.ErrInputConflict
	}
	if r, ok := duplicate(s.data, in); ok {
		s.mu.Unlock()
		return r, nil
	}
	s.mu.Unlock()
	if in.When != "propose" {
		// Delegated input may not execute slash commands: those commands
		// accept a single actor and cannot check both contributors' rights.
		if in.ViaActor != "" && strings.HasPrefix(strings.TrimSpace(in.Content.Text()), "/") {
			return api.Receipt{}, errors.New("delegated input cannot run a command")
		}
		v, err := c.h.API().Invoke(api.AsActor(ctx, in.Actor), "input", api.InputEvent{Session: id, Input: in})
		if err != nil {
			return api.Receipt{}, err
		}
		event := v.(api.InputEvent)
		if event.Handled {
			return api.Receipt{ID: in.ID, When: "command", Command: event.Result}, nil
		}
		event.Input.Actor, event.Input.ViaActor, event.Input.ConnectionRights = in.Actor, in.ViaActor, in.ConnectionRights
		in = event.Input
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !api.SessionScopeAllows(ctx, s.data.Project, s.data.Tenant) || !c.canAdmit(s.data, in) {
		return api.Receipt{}, api.ErrAuthority
	}
	if !api.InputWatermarkMatches(ctx, s.data) {
		return api.Receipt{}, api.ErrInputConflict
	}
	if r, ok := duplicate(s.data, in); ok {
		return r, nil
	}
	starting := []string{}
	for _, right := range api.Rights {
		if api.ConnectionAllows(ctx, right) && c.authorized(s.data, in.Actor, right) &&
			(in.ViaActor == "" || c.authorized(s.data, in.ViaActor, right)) {
			starting = append(starting, right)
		}
	}
	in.ConnectionRights = &starting
	in.TraceContext = telemetry.WorkWire(ctx)
	r, err := c.admitLocked(s, in, ctx)
	if errors.Is(err, api.ErrCapacity) {
		telemetry.Event(ctx, "modular_agent.capacity.refused")
	}
	return r, err
}
func duplicate(s api.Session, input api.Input) (api.Receipt, bool) {
	key := input.Key
	submitter := func(actor, via string) string {
		if via != "" {
			return via
		}
		return actor
	}
	scope := func(actor, via string) bool {
		return actor != "" && actor == input.Actor && submitter(actor, via) == submitter(input.Actor, input.ViaActor)
	}
	if key != "" {
		for _, e := range s.LiveEntries() {
			if e.Kind != "erasure" || e.IsErased() {
				continue
			}
			for _, reservation := range api.ReadErasureRecord(e.Data).InputKeys {
				if reservation.Key == key && scope(reservation.ActorID, reservation.SubmittedBy) && !slices.ContainsFunc(s.Entries, func(candidate api.Entry) bool {
					return candidate.Kind == "input.accepted" && recordedInputID(candidate) == reservation.InputID
				}) {
					return api.Receipt{Duplicate: true, Erased: true}, true
				}
			}
		}
		for _, e := range s.LiveEntries() {
			if e.Kind == "input" && e.InputKey == key && scope(e.Actor, "") {
				return api.Receipt{ID: e.InputID(), When: "now", Duplicate: true}, true
			}
			if e.Kind == "input.accepted" {
				in := api.Decode[api.Input](e.Data)
				if in.Key == key && scope(in.Actor, in.ViaActor) {
					taken := in.Taken
					if taken == "" && in.When == "propose" {
						taken = "proposed"
					}
					return api.Receipt{ID: in.ID, When: taken, Duplicate: true}, true
				}
			}
		}
	}
	return api.Receipt{}, false
}
func (s *session) takeLocked(in api.Input, turn string) (api.Entry, error) {
	var source string
	actor := in.Actor
	for _, e := range s.data.Entries {
		if e.Kind == "input" && api.Decode[string](e.Data) == in.ID {
			return e, nil
		}
		if e.Kind == "input.accepted" && api.Decode[api.Input](e.Data).ID == in.ID {
			source = e.ID
			// Keep the admission's attribution. Job rights still govern the
			// work; the synthetic in-process job actor is not a member.
			if in.Job != "" && e.Actor != "" {
				actor = e.Actor
			}
		}
	}
	sources := append([]string(nil), in.Copies...)
	if source != "" {
		sources = append(sources, source)
	}
	return s.recordLocked(api.Entry{Kind: "input", Turn: turn, Visible: true, Content: in.Content, Actor: actor, Job: in.Job, Copies: sources, InputKey: in.Key, Data: api.JSON(in.ID)}, "harness", true)
}
func (h *Harness) run(ctx context.Context, s *session, in api.Input) {
	for {
		outcome := h.runOne(ctx, s, in)
		s.mu.Lock()
		if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) && (ctx.Err() != nil || outcome.Status == "cancelled") {
			outcome.Returned = nil
			var continuations []api.Input
			for _, queued := range s.queue {
				if queued.Continuation != "" {
					continuations = append(continuations, queued)
				} else {
					outcome.Returned = append(outcome.Returned, queued)
				}
			}
			if len(outcome.Returned) > 0 {
				next := s.data
				next.Entries = slices.Clip(next.Entries)
				for _, queued := range outcome.Returned {
					appendEntry(&next, api.Entry{Kind: "input.returned", Actor: queued.Actor, InputRef: queued.ID,
						Data: api.JSON(map[string]string{"reason": "cancelled"})}, "harness", true)
				}
				if err := s.commitLocked(next); err != nil {
					outcome.Error = err.Error()
				}
			}
			s.queue = continuations
		}
		s.last = outcome
		h.queueInterfaceContinuationsLocked(s)
		nextInput := runnableInput(s.queue)
		if nextInput < 0 || s.closing || s.writerFailure != nil || ctx.Err() != nil {
			s.running = false
			s.cancel(nil)
			done := s.done
			if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
				h.startInterfaceContinuationsLocked(s)
			}
			s.mu.Unlock()
			if len(outcome.Returned) > 0 {
				h.API().Emit(context.Background(), api.Event{Kind: "input.returned", Session: s.id, Data: api.JSON(outcome.Returned)})
			}
			close(done)
			return
		}
		in = s.queue[nextInput]
		s.queue = slices.Delete(s.queue, nextInput, nextInput+1)
		s.mu.Unlock()
	}
}
func (h *Harness) runOne(ctx context.Context, s *session, in api.Input) (out api.Outcome) {
	defer func() {
		if p := recover(); p != nil {
			out = api.Outcome{Status: "failed", Error: fmt.Sprintf("Runtime panic: %v", p)}
		}
	}()
	s.mu.Lock()
	if len(s.external) > 0 {
		calls := s.external
		s.external = nil
		s.mu.Unlock()
		return h.runExternal(ctx, s, calls)
	}
	resume := s.resume
	s.steeringClosed = false
	s.activeActor, s.activeInput = in.Actor, in
	s.resume = nil
	if resume != nil {
		in = turnAdmission(s.data, *resume)
		if resume.Actor != "" {
			in.Actor = resume.Actor
		} else if in.Actor == "" {
			start := api.Decode[api.TurnStart](resume.Data)
			if start.StartedBy.Kind == "actor" {
				for _, e := range s.data.Branch() {
					if e.Turn == resume.Turn && e.Kind == "input" && e.Actor == start.StartedBy.ID {
						in.Actor = e.Actor
						break
					}
				}
			}
		}
		s.activeActor, s.activeInput = in.Actor, in
	}
	snap := copySession(s.data)
	s.mu.Unlock()
	v, err := h.API().Get("runtime")
	if err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	runtime := v.(api.Runtime)
	selection, err := h.API().Get("selection")
	if err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	selectionView := snap
	if resume != nil {
		selectionView.Settings = turnSettings(snap.Settings, api.Decode[api.TurnStart](resume.Data).Settings)
	}
	selectionView.Settings.Model = h.currentModel(selectionView.Settings.Model)
	access, resolveErr := selection.(api.Selection).Resolve(selectionView)
	turnID := api.ID()
	if resume != nil {
		turnID = resume.Turn
	}
	ctx = telemetry.Scope(telemetry.WorkParent(ctx, in.TraceContext), snap.ID, turnID, "", h.agentName)
	ctx = api.WithExecution(api.AsActor(ctx, in.Actor), api.Execution{Session: snap.ID, Turn: turnID})
	ctx = api.WithJobContributors(api.WithConnectionRights(ctx, in.ConnectionRights), in.Actor, in.ViaActor, in.ReleasedBy)
	var tools []api.Tool
	seen := map[string]bool{}
	for _, source := range h.API().All("tools.") {
		for _, tool := range source.(api.ToolSource).Tools(snap) {
			if seen[tool.Name] {
				return api.Outcome{Status: "failed", Error: "duplicate tool " + tool.Name}
			}
			seen[tool.Name] = true
			if registered := h.interfaceTools[tool.Name]; registered != nil && (access != nil && access.Model().RunsTools || !runtime.Declaration().InterfaceTools || !h.interfaceAvailable(s, registered, tool.Name, in, turnID)) {
				continue
			}
			tools = append(tools, tool)
		}
	}
	before := api.BeforeTurn{Session: snap, Turn: turnID, Input: in.Content, Tools: tools}
	prepared, err := h.API().Invoke(ctx, "turn.prepare", before)
	if err != nil {
		if ctx.Err() != nil && !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			if in.ID != "" && resume == nil {
				_, recordErr := h.API().Record(context.Background(), s.id, api.Entry{Kind: "input.returned", Data: api.JSON(in.ID)})
				if recordErr != nil {
					return api.Outcome{Status: "cancelled", Error: recordErr.Error()}
				}
			}
			return api.Outcome{Status: "cancelled", Error: ctx.Err().Error()}
		}
		if h.handBackOnOpen {
			h.mu.RLock()
			owner := h.caps["runtime"].owner
			h.mu.RUnlock()
			ports := &turnPorts{c: &client{h: h, owner: owner}, s: s, id: turnID, actor: in.Actor, input: in}
			return unavailableTurn(ctx, ports, selectionView.Settings, before, nil, resume, err)
		}
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	h.mu.RLock()
	owner := h.caps["runtime"].owner
	h.mu.RUnlock()
	ports := &turnPorts{c: &client{h: h, owner: owner}, s: s, id: turnID, actor: in.Actor, input: in, tools: tools}
	if err := ports.CheckTenantBudget(); err != nil {
		return unavailableTurn(ctx, ports, selectionView.Settings, prepared.(api.BeforeTurn), tools, resume, err)
	}
	if resolveErr != nil {
		return unavailableTurn(ctx, ports, selectionView.Settings, prepared.(api.BeforeTurn), tools, resume, resolveErr)
	}
	ports.model = access.Model()
	turn := api.Turn{ID: ports.id, Session: snap.ID, Actor: in.Actor, Input: in.ID, Settings: snap.Settings, System: prepared.(api.BeforeTurn).System, Context: prepared.(api.BeforeTurn).Context, Access: access, Tools: tools, IO: ports, CanRepeat: true}
	turn.Reopen, turn.Continuing = in.Calls, len(in.Calls) > 0 || in.Continuation != ""
	turn.StartedBy = api.TurnStarter{Kind: "actor", ID: in.Actor}
	if in.Job != "" {
		turn.StartedBy = api.TurnStarter{Kind: "job", ID: in.Job}
	} else if in.Continuation != "" {
		turn.StartedBy = in.ContinuedBy
	} else if turn.Continuing {
		answer := in.Answer
		if answer == "" {
			answer = in.ID
		}
		turn.StartedBy = api.TurnStarter{Kind: "answer", ID: answer}
	}
	if resume != nil {
		start := api.Decode[api.TurnStart](resume.Data)
		turn.ID, ports.id = resume.Turn, resume.Turn
		turn.Actor, ports.actor = in.Actor, in.Actor
		turn.Input, turn.Settings, turn.Resume = start.Input, selectionView.Settings, true
		if turn.Input == "" {
			for _, e := range snap.Branch() {
				if e.Turn == turn.ID && e.Kind == "input" {
					turn.Input = e.InputID()
					break
				}
			}
		}
		turn.Reopen = start.Calls
		if len(turn.Reopen) == 0 && start.StartedBy.Kind == "answer" {
			for _, c := range api.OpenCalls(snap) {
				if c.Step != "" {
					turn.Reopen = append(turn.Reopen, c)
				}
			}
		}
		if start.StartedBy.Kind != "" {
			turn.StartedBy = start.StartedBy
		}
		turn.System, turn.Context = start.System, start.Context
	}
	if env, err := h.API().Get("working-environment"); err == nil {
		turn.CanRepeat = env.(api.WorkingEnvironment).StopsOnCrash()
	}
	turn.Settings.Thinking = api.LowerReasoning(turn.Settings.Thinking, access.Model().Thinking)
	return h.runTraced(ctx, ports, turn, resume, snap, runtime)
}
func (c *client) CancelAs(ctx context.Context, id string) error {
	if !c.Authorize(id, api.Acting(ctx), "cancel") {
		return errors.New("cancel refused")
	}
	return c.cancel(ctx, id)
}
func (c *client) Cancel(id string) error { return c.cancel(context.Background(), id) }

func (c *client) cancel(ctx context.Context, id string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		s.cancel(context.Canceled)
	}
	if err := c.h.settleInterfacesLocked(s, "", "Interface call cancelled before its outcome was known."); err != nil {
		return err
	}
	c.h.startInterfaceContinuationsLocked(s)
	return nil
}
func (c *client) Withdraw(ctx context.Context, id, input string) (api.Input, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Input{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, in := range s.queue {
		if in.ID == input {
			if api.Acting(ctx) != in.Actor && !c.authorized(s.data, api.Acting(ctx), "input") {
				return api.Input{}, errors.New("withdraw refused")
			}
			if _, err = s.recordLocked(api.Entry{Kind: "input.returned", Data: api.JSON([]string{input})}, "harness", true); err != nil {
				return api.Input{}, err
			}
			s.queue = append(s.queue[:i], s.queue[i+1:]...)
			return in, nil
		}
	}
	return api.Input{}, errors.New("input already taken")
}
func (c *client) Wait(ctx context.Context, id string) (api.Outcome, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Outcome{}, err
	}
	for {
		s.mu.Lock()
		running, done, last, failure := s.running, s.done, clone(s.last), s.writerFailure
		s.mu.Unlock()
		if failure != nil {
			return api.Outcome{}, failure
		}
		if !running {
			if done != nil {
				select {
				case <-done:
				default:
					select {
					case <-done:
						continue
					case <-ctx.Done():
						return api.Outcome{}, ctx.Err()
					}
				}
			}
			out, gateErr := c.OutputValue(ctx, api.Event{Kind: "turn.outcome", Session: id, Data: api.JSON(last)})
			if gateErr != nil {
				return api.Outcome{}, gateErr
			}
			return api.Decode[api.Outcome](out.Data), nil
		}
		select {
		case <-ctx.Done():
			return api.Outcome{}, ctx.Err()
		case <-done:
		case <-s.interrupted:
		}
	}
}
func (c *client) CloseSession(id string) error { return c.stopSession(id, true) }
func (c *client) StopSession(id string) error  { return c.stopSession(id, false) }
func (c *client) CloseAs(id, who string) error {
	return c.CloseFor(api.AsActor(context.Background(), who), id)
}
func (c *client) CloseFor(ctx context.Context, id string) error {
	return c.stopSessionAs(ctx, id, true, api.Acting(ctx), api.ActingVia(ctx))
}

func (c *client) stopSession(id string, closing bool) error {
	return c.stopSessionAs(context.Background(), id, closing, "", "")
}

func (c *client) stopSessionAs(ctx context.Context, id string, closing bool, who, via string) (errOut error) {
	if closing {
		var span trace.Span
		ctx, span = telemetry.Start(telemetry.Session(ctx, id), "modular_agent.session.close", trace.WithAttributes(telemetry.String("modular_agent.session.operation", "close")))
		defer func() { telemetry.Finish(span, errOut) }()
	}
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if who != "" {
		_, member := actors(s.data)[who]
		if !member || (s.running || hasUnfinishedJobs(s.data) || hasOpenInterfaces(s.data)) && !c.authorizedBy(s.data, ctx, "cancel") {
			s.mu.Unlock()
			return api.ErrCloseForbidden
		}
	}
	if via != "" {
		_, member := actors(s.data)[via]
		if !member {
			s.mu.Unlock()
			return api.ErrCloseForbidden
		}
	}
	if s.stopping {
		s.mu.Unlock()
		return errors.New("session close already in progress")
	}
	if len(s.commandCancels) != 0 {
		s.mu.Unlock()
		return errors.New("session has a direct command in progress")
	}
	if closing && s.writerFailure == nil {
		if err := c.h.settleInterfacesLocked(s, "", "Session closed before the Interface call's outcome was known."); err != nil {
			s.mu.Unlock()
			return err
		}
	}
	s.stopping, s.closing = true, true
	if s.interfaceTimer != nil {
		s.interfaceTimer.Stop()
	}
	for _, connection := range s.interfaceConnections {
		connection.closeLocked()
	}
	s.interfaceConnections = nil
	if s.running {
		cause := error(context.Canceled)
		if !closing {
			cause = api.ErrProcessStopped
		}
		s.cancel(cause)
	}
	done := s.done
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.stopping = false
		s.mu.Unlock()
	}()
	if done != nil {
		<-done // A lost writer still has to stop old work before releasing its lease.
	}
	s.mu.Lock()
	interrupted := s.writerFailure != nil
	s.mu.Unlock()
	if closing && !interrupted {
		snap, _ := c.Snapshot(id)
		for _, call := range api.OpenCalls(snap) {
			result := api.ToolResult{Call: call.ID, Reference: call.Reference, Status: "cancelled", Content: api.Text("Session closed before the call finished.")}
			if _, e := c.Record(context.Background(), id, api.Entry{Kind: "tool.result", Call: call.ID, Actor: call.Actor, Visible: true, Content: result.Content, Data: api.JSON(result)}); e != nil {
				return e
			}
		}
	}
	hook := "session.stop"
	if closing && !interrupted {
		hook = "session.end"
	}
	_, err = c.h.API().Invoke(context.WithoutCancel(ctx), hook, id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	for id := range s.jobSpans {
		s.endJobSpan(id, "interrupted")
	}
	close(s.writerWatchDone)
	if s.lease != nil {
		err = s.lease.Close()
	}
	s.mu.Unlock()
	c.h.mu.Lock()
	delete(c.h.sessions, id)
	c.h.mu.Unlock()
	c.dropOutput(id)
	if closing && !interrupted {
		c.Emit(context.Background(), api.Event{Kind: "session.end", Session: id, Data: api.JSON(map[string]any{"sessionId": id})})
	}
	return err
}
func (c *client) Emit(ctx context.Context, e api.Event) {
	// A failing output gate drops the event. A listener cannot change execution.
	defer func() { _ = recover() }()
	if epoch, err := c.ErasureEpoch(e.Session); err != nil {
		return
	} else {
		e.ErasureEpoch = epoch
	}
	e.Time = time.Now().UTC()
	out, err := c.output(ctx, e)
	if err == nil && !out.Hold {
		if strings.HasPrefix(e.Kind, "plugin.") && !bytes.Equal(e.Data, out.Event.Data) {
			out.Event.OutputChanged = true
		}
		out.Event.ErasureEpoch = e.ErasureEpoch
		e = out.Event
	}
	events, release := c.streamOutput(e, err != nil || out.Hold)
	defer release()
	if len(events) == 0 {
		return
	}
	c.deliverOutput(ctx, e, events)
}

type turnPorts struct {
	c         *client
	s         *session
	id, actor string
	input     api.Input
	model     api.Model
	tools     []api.Tool
}

// Turn settings fall back to session settings for fields an older or foreign
// host did not record. The selected model, when present, belongs to the turn.
func turnSettings(session, recorded api.Settings) api.Settings {
	if recorded.Model == "" {
		recorded.Model = session.Model
	}
	if recorded.Thinking == "" {
		recorded.Thinking = session.Thinking
	}
	if recorded.MaxSteps == 0 {
		recorded.MaxSteps = session.MaxSteps
	}
	if recorded.MaxOutput == 0 {
		recorded.MaxOutput = session.MaxOutput
	}
	if recorded.Approval == "" {
		recorded.Approval = session.Approval
	}
	return recorded
}

func (p *turnPorts) Hook(ctx context.Context, name string, v any) (any, error) {
	ctx = api.WithExecution(api.AsActor(ctx, p.actor), api.Execution{Session: p.s.id, Turn: p.id})
	if name == "runtime.tool.before" {
		check := v.(api.ToolCheck)
		if !p.canRunTools(check.Call.Actor) {
			return nil, errors.New("tool authority refused")
		}
		ctx = api.WithExecution(ctx, api.Execution{Session: p.s.id, Turn: p.id, Call: check.Call, ToolSource: p.toolRegistration(check.Call.Name)})
		changed, err := p.c.Invoke(ctx, name, v)
		if err != nil {
			return nil, err
		}
		check = changed.(api.ToolCheck)
		if (check.Call.ParentCall != "" || p.c.h.interfaceTools[check.Call.Name] != nil) && check.InputChanged && !check.Open && check.Refused == "" {
			check.InputChanged, check.Validate = false, nil
			ctx = api.WithExecution(ctx, api.Execution{Session: p.s.id, Turn: p.id, Call: check.Call, ToolSource: p.toolRegistration(check.Call.Name)})
			changed, err = p.c.Invoke(ctx, name, check)
			if err != nil {
				return nil, err
			}
			check = changed.(api.ToolCheck)
			if check.InputChanged {
				return nil, errors.New("tool gate changed input on its second pass")
			}
		}
		validate := check.Validate
		check.Validate = func(call api.Call) error {
			if validate != nil {
				if err := validate(call); err != nil {
					return err
				}
			}
			if !p.canRunTools(call.Actor) {
				return errors.New("tool authority refused")
			}
			return nil
		}
		return check, nil
	}
	if name == "runtime.result" {
		check := v.(api.ResultCheck)
		check.Shape = p.input.ResultSchema
		if len(check.Shape) != 0 && len(check.Value) == 0 {
			text := json.RawMessage(check.Result.Text())
			if json.Valid(text) {
				check.Value = text
			}
		}
		v = check
	}
	changed, err := p.c.Invoke(ctx, name, v)
	if name == "runtime.tool.after" {
		before := v.(api.AfterTool)
		result := before.Result
		if err == nil {
			after := changed.(api.AfterTool).Result
			result.Content, result.Structured = after.Content, after.Structured
			err = api.ValidateToolResult(result)
		}
		if err != nil {
			// Preserve the fact and status of dispatch, not the unchecked output.
			result.Content = api.Text("Tool result processing failed.")
			result.Structured, result.Data, result.Wire = nil, nil, nil
			result.ProcessingError = errors.Join(result.ProcessingError, err)
		}
		// Validate the original result first. If it cannot fit the
		// settlement reservation, preserve dispatch status, not its data.
		if len(api.JSON(result)) > 1<<20 {
			result.Content = api.Text(api.ErrResultTooLarge.Error())
			result.Structured, result.Data, result.Wire, result.Copies = nil, nil, nil, nil
			result.ProcessingError = errors.Join(result.ProcessingError, api.ErrResultTooLarge)
		}
		before.Result = result
		return before, nil
	}
	if err != nil {
		return nil, err
	}
	switch name {
	case "runtime.result":
		result := changed.(api.ResultCheck)
		if len(p.input.ResultSchema) != 0 && result.Continue == "" {
			if err := api.ValidateResult(p.input.ResultSchema, &result); err != nil {
				result.Continue = err.Error()
			}
			changed = result
		}
		if result.Continue != "" {
			if _, err := p.Record(ctx, api.Entry{Kind: "resultFeedback", Visible: true, Data: api.JSON(result.Continue)}); err != nil {
				return nil, err
			}
		}
	case "runtime.step.before":
		step := changed.(api.StepContext)
		if len(p.input.ResultSchema) != 0 {
			step.Request.System += "\nReturn the final answer as a single JSON value matching this schema (no Markdown): " + string(p.input.ResultSchema)
		}
		snap, err := p.Snapshot()
		if err != nil {
			return nil, err
		}
		branch := snap.Branch()
		start := len(branch)
		for start > 0 {
			e := branch[start-1]
			if e.Turn == p.id && e.WasKind("model.request") {
				break
			}
			start--
		}
		for _, e := range branch[start:] {
			if e.Turn == p.id && e.Kind == "resultFeedback" {
				step.Request.Messages = append(step.Request.Messages, api.Message{Role: "user", Content: api.Text(api.Decode[string](e.Data))})
				step.Sources = append(step.Sources, e.ID)
			}
		}
		changed = step
	}
	return changed, nil
}
func (p *turnPorts) CheckWriter() error {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if err := p.s.reconcileErasureLocked(); err != nil {
		return err
	}
	return p.s.checkWriterLocked()
}

// ToolRegistration resolves the currently registered source and definition.
// The source may refresh, so do not hold either Harness lock while reading it.
func (p *turnPorts) ToolRegistration(name string) (string, string, api.Tool, bool) {
	plugin, source, definition, _, _, found := p.resolveTool(name)
	return plugin, source, definition, found
}

func (p *turnPorts) resolveTool(name string) (plugin, source string, definition api.Tool, executor api.ToolSource, snap api.Session, found bool) {
	snap, err := p.Snapshot()
	if err != nil {
		return
	}
	p.c.h.mu.RLock()
	sources := map[string]registration{}
	for id, r := range p.c.h.caps {
		if strings.HasPrefix(id, "tools.") {
			sources[id] = r
		}
	}
	p.c.h.mu.RUnlock()
	for id, r := range sources {
		s := r.value.(api.ToolSource)
		for _, tool := range s.Tools(snap) {
			if tool.Name != name {
				continue
			}
			if found {
				return "", "", api.Tool{}, nil, snap, false
			}
			plugin, source = r.owner, strings.TrimPrefix(id, "tools.")
			if identity, ok := s.(interface{ ToolSourceIdentity() (string, string) }); ok {
				plugin, source = identity.ToolSourceIdentity()
			}
			definition, executor, found = tool, s, true
		}
	}
	return
}

func (p *turnPorts) CheckTenantBudget() error {
	p.s.mu.Lock()
	name := p.s.data.Tenant
	p.s.mu.Unlock()
	return p.c.checkBudget(name)
}

func (p *turnPorts) ResultShape() json.RawMessage { return p.input.ResultSchema }

func (p *turnPorts) Snapshot() (api.Session, error) {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if err := p.s.reconcileErasureLocked(); err != nil {
		return api.Session{}, err
	}
	snap := copySession(p.s.data)
	if err := p.s.admitErasureView(snap); err != nil {
		return api.Session{}, err
	}
	return snap, nil
}
func (p *turnPorts) Record(ctx context.Context, e api.Entry) (api.Entry, error) {
	e.Turn = p.id
	e.Actor = p.actor
	if e.Kind == "tool.started" {
		call := api.Decode[api.Call](e.Data)
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
	if e.Kind == "turn.end" && (len(p.c.h.interfaceTools) != 0 || len(api.InterfaceHandoffs(p.rawSnapshot())) != 0) {
		return p.recordInterfaceTurnEnd(ctx, e)
	}
	if e.Kind != "turn.start" {
		if e.Kind == "input" {
			if e.InputID() == "" {
				e.Data = api.JSON(api.ID())
			}
			in := api.Input{ID: e.InputID(), Key: e.InputKey, Actor: e.Actor, When: "steer", Content: e.Content, Copies: e.Copies}
			accepted, err := p.c.Record(ctx, p.s.id, api.Entry{Kind: "input.accepted", Turn: p.id, Actor: e.Actor, Content: in.Content, Copies: in.Copies, Data: api.JSON(in)})
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
func (p *turnPorts) Emit(ctx context.Context, e api.Event) {
	e.Session = p.s.id
	e.Turn = p.id
	e.Actor = p.actor
	p.c.Emit(ctx, e)
}
func (p *turnPorts) TakeSteering(ctx context.Context) (bool, error) {
	entries, err := p.TakeSteeringEntries(ctx)
	return len(entries) > 0, err
}
func (p *turnPorts) TakeSteeringEntries(ctx context.Context) ([]api.Entry, error) {
	return p.TakeSteeringBoundary(ctx, false)
}

func (p *turnPorts) TakeSteeringBoundary(ctx context.Context, final bool) ([]api.Entry, error) {
	s := p.s
	s.mu.Lock()
	defer s.mu.Unlock()
	var entries []api.Entry
	for i := 0; i < len(s.queue); {
		in := s.queue[i]
		if in.When != "steer" {
			i++
			continue
		}
		if err := ctx.Err(); err != nil {
			return entries, err
		}
		e, err := s.takeLocked(in, p.id)
		if err != nil {
			return entries, err
		}
		entries = append(entries, e)
		s.queue = slices.Delete(s.queue, i, i+1)
	}
	if final && len(entries) == 0 {
		s.steeringClosed = true
	}
	return entries, nil
}
func (p *turnPorts) HasSteering() bool {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	return slices.ContainsFunc(p.s.queue, func(in api.Input) bool { return in.When == "steer" })
}
func (p *turnPorts) RunTool(ctx context.Context, call api.Call) (result api.ToolResult) {
	defer func() {
		if result.NotDispatched {
			toolDisposition(ctx, call, result.Status)
		}
	}()
	plugin, id, def, source, snap, found := p.resolveTool(call.Name)
	if !found || !api.CanCall(def, call.Origin) || !p.canRunTools(call.Actor) {
		return api.ToolResult{Call: call.ID, Status: "refused", NotDispatched: true}
	}
	if err := validateToolInput(def, call.Input); err != nil {
		return api.ToolResult{Call: call.ID, Status: "failed", Content: api.Text(err.Error()), NotDispatched: true}
	}
	if ctx.Err() != nil || p.CheckWriter() != nil || !p.canRunTools(call.Actor) {
		return api.ToolResult{Call: call.ID, Status: "not_started", NotDispatched: true}
	}
	result, err := p.executeTool(ctx, source, snap, call, api.ToolRegistration{Plugin: plugin, ToolSource: id}, 0)
	result.Returns = def.Output
	if err != nil {
		result.ProcessingError = err
	}
	return result
}
