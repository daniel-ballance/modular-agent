package harness

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"go.opentelemetry.io/otel/trace"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
)

type session struct {
	committed            chan struct{} // closed on the next published snapshot; guarded by mu
	approvalDeliveries   map[approvalDelivery]string
	approvalTimer        worktime.Timer
	interfaceConnections []*InterfaceConnection
	interfaceSpans       map[string]trace.SpanContext
	interfaceParents     map[string]*telemetry.Wire
	interfaceUnreleased  map[string]bool
	interfaceTimer       worktime.Timer
	interfaceReports     sync.Mutex
	continuationWaiters  map[chan struct{}]string
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
	startupWriter        bool // retained until explicit close or process shutdown
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
		if !c.h.volatileHistory {
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
	return c.open(ctx, id, nil, false)
}

func (c *client) OpenForHost(ctx context.Context, id string, host api.Actor) error {
	return c.open(ctx, id, &host, false)
}

// OpenInterruptedForHost uses normal recovery, but checks the candidate again
// under a nonwaiting lease before it joins an actor or installs any work.
func (c *client) OpenInterruptedForHost(ctx context.Context, id string, host api.Actor) error {
	return c.open(ctx, id, &host, true)
}

func (c *client) StartupWriter(id string) bool {
	s, err := c.find(id)
	return err == nil && s.startupWriter
}

func (c *client) open(ctx context.Context, id string, host *api.Actor, interruptedOnly bool) (errOut error) {
	ctx, span := telemetry.Start(telemetry.Session(ctx, id), "modular_agent.session.open", trace.WithAttributes(telemetry.String("modular_agent.session.operation", "load")))
	defer func() { telemetry.Finish(span, errOut) }()
	if err := c.seedCapacity(); err != nil {
		return err
	}
	v, err := c.Get("history")
	if err != nil {
		return err
	}
	var lease api.Lease
	if interruptedOnly {
		lease, err = tryAcquireHistory(v.(api.Store), id)
	} else {
		lease, err = acquireHistory(ctx, v.(api.Store), id)
	}
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
	if err := validateIntake(snap); err != nil {
		_ = lease.Close()
		return err
	}
	if interruptedOnly {
		// Startup is not a new membership grant. Apply the recorded local
		// actor's watch right, including the session and tenant ceilings.
		if !c.authorized(snap, host.ID, "watch") {
			_ = lease.Close()
			return api.ErrAuthority
		}
		if snap.UnfinishedTurn() == nil {
			_ = lease.Close()
			return errors.New("no interrupted turn")
		}
	}
	if c.h.SupportsWaitingApprovals() && snap.Settings.ApprovalWait == "" {
		snap.Settings.ApprovalWait = "live"
	}
	savedApproval := snap.Settings.Approval
	if conf, err := c.Get("configuration"); err == nil {
		if defaults, err := conf.(api.Configuration).Settings(snap.Project); err == nil {
			// Apply session settings over the configured defaults for new turns.
			view := snap
			view.Settings = defaults
			view.Entries = slices.Clone(snap.Entries)
			snap.Settings = portable.Session(view).Settings
		}
	}
	project, err := filepath.EvalSymlinks(snap.Project)
	if err != nil {
		_ = lease.Close()
		return err
	}
	s := c.newSessionState(id, project)
	s.tenant = snap.Tenant
	s.startupWriter = interruptedOnly
	s.data, s.lease, s.last, s.opening = snap, lease, recordedOutcome(snap), true
	if err = s.reconcileErasureLocked(); err != nil {
		_ = lease.Close()
		return err
	}
	s.data.Settings.Approval = api.ReopenedApproval(savedApproval)
	snap = s.data
	if err = c.registerOpen(ctx, s, host); err != nil {
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
			next := s.data
			next.Entries = slices.Clip(next.Entries)
			for _, id := range ids {
				appendEntry(&next, api.Entry{Kind: "input.returned", InputRef: id, Data: api.JSON("restart")}, "harness", true)
			}
			if err = s.commitLocked(next); err != nil {
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

func (c *client) registerOpen(ctx context.Context, s *session, host *api.Actor) error {
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
	if s.approvalTimer != nil {
		s.approvalTimer.Stop()
		s.approvalTimer = nil
	}
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
		waits := api.WaitingApprovals(snap)
		for _, call := range api.OpenCalls(snap) {
			if w := waits[call.ID]; w != nil && w.Listed && w.Start.ID == "" {
				continue
			}
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
