// Package acpinterface is a stable ACP v1 stdio Interface.
// Wire types and dispatch come from the maintained community Go SDK.
// Sources: https://agentclientprotocol.com/protocol/v1/session-setup
// https://github.com/caelis-labs/acp-go-sdk/tree/v1.7.0
package acpinterface

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/mcptools"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"unicode/utf8"

	acp "github.com/caelis-labs/acp-go-sdk"
)

const Namespace = "modular-agent"
const Binding = "modular-agent-acp/1"
const Binding2 = "modular-agent-acp/2"
const actor = "local-user"

type Interface struct {
	a       api.API
	project string
	network connectionAttachments
}

func Plugin(project string) api.Plugin {
	return api.Plugin{Name: "acp-interface", Setup: func(a api.API) error { return a.Provide("interface.acp", &Interface{a: a, project: project}) }}
}

type attachment struct {
	actor      string
	ctx        context.Context
	cancel     context.CancelFunc
	disconnect func()
	joined     map[string]func()
	busy       bool
	loading    bool
	pending    []api.BufferedEvent
	streamed   map[string]bool
	models     map[string]api.BufferedEvent
	progress   map[string]api.BufferedEvent
	requests   map[questionRecipient]context.CancelFunc
	polled     map[questionRecipient]bool
}
type server struct {
	declared         func() map[string]any
	projects         *projectHosts
	resources        Projects
	a                api.API
	project          string
	actor            string
	principal        *Principal
	connectionRights sync.Map // session id -> connection ceiling; never writes recorded grants
	ctx              context.Context
	peer             *acp.AgentSideConnection
	mu               sync.Mutex
	lifecycle        sync.Mutex
	shared           *connectionAttachments
	closed           bool
	initialized      bool
	binding          string
	capabilities     acp.ClientCapabilities
	represents       map[string]bool
	sessions         map[string]*attachment
	wg               sync.WaitGroup
}

// Serve owns the connection streams. EOF interrupts, rather than explicitly
// closing, sessions so the selected Runtime retains its recovery semantics.
func (i *Interface) Serve(ctx context.Context, in io.ReadCloser, out io.Writer) error {
	return i.ServeWithDeclaration(ctx, in, out, nil)
}

// ServeWithDeclaration serves this composition's public capability declaration.
func (i *Interface) ServeWithDeclaration(ctx context.Context, in io.ReadCloser, out io.Writer, declared func() map[string]any, configs ...Projects) error {
	var config Projects
	if len(configs) > 0 {
		config = configs[0]
	}
	policy := Principal{}
	if tenants, ok := i.a.(interface{ StdioTenantGrants() ([]string, error) }); ok {
		grants, err := tenants.StdioTenantGrants()
		if err != nil {
			return err
		}
		policy.Tenants = grants
	}
	return i.ServeStdio(ctx, in, out, declared, config, policy)
}

// ServeStdio serves the configured local principal. A nil rights ceiling leaves
// recorded grants unchanged and uses the normal prospective rights on creation.
func (i *Interface) ServeStdio(ctx context.Context, in io.ReadCloser, out io.Writer, declared func() map[string]any, config Projects, policy Principal) error {
	if policy.Actor.ID == "" {
		policy.Actor.ID, policy.Actor.Kind = actor, "host"
		if id, set := os.LookupEnv("MODULAR_AGENT_ACTOR"); set {
			if id == "" || !utf8.ValidString(id) {
				return errors.New("MODULAR_AGENT_ACTOR must be a nonempty UTF-8 id")
			}
			policy.Actor.ID = id
		}
	}
	if raw := os.Getenv("MODULAR_AGENT_ACP_REPRESENTS"); policy.Represents == nil && raw != "" {
		if err := json.Unmarshal([]byte(raw), &policy.Represents); err != nil || policy.Represents == nil {
			return errors.New("MODULAR_AGENT_ACP_REPRESENTS must be a JSON array of principal IDs")
		}
	}
	policy.TrustTrace = true // The launcher supplies the stdio peer.
	return i.serve(ctx, in, out, declared, config, policy.Actor.ID, &policy)
}

func (i *Interface) serve(ctx context.Context, in io.ReadCloser, out io.Writer, declared func() map[string]any, config Projects, who string, principal *Principal) error {
	project, err := configuration.Canonical(i.project)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	represented := map[string]bool{}
	for _, id := range principal.Represents {
		if id == "" || !utf8.ValidString(id) {
			return errors.New("invalid ACP represented principal")
		}
		represented[id] = true
	}
	s := &server{declared: declared, a: i.a, project: project, actor: who, principal: principal, ctx: ctx, represents: represented, sessions: map[string]*attachment{}, resources: config}
	if config.Compose != nil {
		s.projects = &projectHosts{compose: config.Compose, hosts: map[projectKey]*server{}}
	}
	if principal != nil {
		s.shared = &i.network
	}
	conn, err := acp.NewAgentSideConnectionWithOptions(s, out, in, acp.ConnectionOptions{MaxFrameSize: (64 << 20) + 2})
	if err != nil {
		return err
	}
	defer s.subscribe()()
	select {
	case <-ctx.Done():
	case <-conn.Done():
	}
	stopped := ctx.Err() != nil
	_ = conn.Close()
	cancel()
	if s.projects != nil {
		h := s.projects
		h.mu.Lock()
		h.closed = true
		h.mu.Unlock()
		for _, clean := range h.cleanups {
			clean()
		}
	}
	s.stop()
	_ = conn.Wait(context.Background())
	err = conn.Err()
	if errors.Is(err, acp.ErrPeerClosed) || stopped {
		return nil
	}
	return err
}

func (s *server) subscribe() func() {
	if a, ok := s.a.(interface {
		SubscribeOutput(func(api.Event) string, func(api.Event)) func()
	}); ok {
		return a.SubscribeOutput(s.outputRecipient, s.event)
	}
	return s.a.Subscribe(s.event)
}

func (s *server) stop() {
	lifecycle := s.sessionLifecycle()
	lifecycle.Lock()
	s.mu.Lock()
	s.closed = true
	attached := s.sessions
	s.sessions = map[string]*attachment{}
	for _, st := range attached {
		st.releaseBuffers()
	}
	s.mu.Unlock()
	for id, st := range attached {
		st.disconnect()
		for _, disconnect := range st.joined {
			disconnect()
		}
		st.cancel()
		if s.unlink(id) {
			_ = s.a.StopSession(id)
		}
	}
	lifecycle.Unlock()
	s.wg.Wait()
}
func (s *server) Initialize(ctx context.Context, p acp.InitializeRequest) (acp.InitializeResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.initialized {
		return acp.InitializeResponse{}, acpError("already_initialized")
	}
	selected := Binding
	if m, provided := p.Meta[Namespace]; provided {
		var fields map[string]json.RawMessage
		if json.Unmarshal(m, &fields) != nil || fields == nil {
			return acp.InitializeResponse{}, acpError("invalid_params")
		}
		if v, present := fields["binding"]; present {
			var binding *string
			if json.Unmarshal(v, &binding) != nil || binding == nil {
				return acp.InitializeResponse{}, acpError("invalid_params")
			}
			selected = *binding
		}
	}
	if p.ProtocolVersion != 1 || (selected != Binding && selected != Binding2) {
		return acp.InitializeResponse{}, acpError("unsupported_version")
	}
	s.binding = selected
	s.initialized = true
	s.capabilities = p.ClientCapabilities
	s.peer, _ = acp.AgentSideConnectionFromContext(ctx)
	return acp.InitializeResponse{
		ProtocolVersion:   acp.ProtocolVersion(acp.WireProtocolVersion),
		AgentInfo:         &acp.Implementation{Name: "modular-agent-go", Version: "0.5"},
		AgentCapabilities: acp.AgentCapabilities{LoadSession: true, McpCapabilities: acp.McpCapabilities{Http: true}, SessionCapabilities: acp.SessionCapabilities{List: &acp.SessionListCapabilities{}, Resume: &acp.SessionResumeCapabilities{}, Close: &acp.SessionCloseCapabilities{}}},
		Meta: map[string]json.RawMessage{Namespace: api.JSON(map[string]any{
			"binding": s.binding, "declaration": s.declaration(""),
			"extensions": []string{"history", "input", "requests", "answer", "fork", "move", "erase", "jobs", "cancel-job", "support", "command", "withdraw", "call_tool", "actors", "join", "leave", "release", "proposals", "limit", "tenant", "interrupted"},
			"actor":      s.hostActor(),
		})},
	}, nil
}
func (s *server) ready() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized {
		return acpError("not_initialized")
	}
	return nil
}
func (s *server) attached(id string) (*attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.sessions[id]
	if st == nil {
		return nil, acp.NewInvalidParams(map[string]any{"reason": "session not attached to this connection"})
	}
	return st, nil
}
func (s *server) requireAttachment(id string) (*attachment, error) {
	if st, err := s.attached(id); err == nil {
		snap, err := s.a.Snapshot(id)
		if err != nil {
			return nil, outputReplyError(err)
		}
		if !s.permitsMembership(snap) {
			return nil, acpError("forbidden")
		}
		return st, nil
	}
	if row, err := s.a.Snapshot(id); err == nil && s.discoverable(row) {
		return nil, acpError("not_open")
	}
	rows, err := s.a.List("")
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.ID == id && s.discoverable(row) {
			return nil, acpError("not_open")
		}
	}
	return nil, acpError("forbidden")
}

func (s *server) mcp() *mcptools.Manager   { v, _ := s.a.Get("mcp"); return v.(*mcptools.Manager) }
func (s *server) questions() api.Questions { v, _ := s.a.Get("questions"); return v.(api.Questions) }
func (s *server) root(cwd string, extra []string, prompt *acp.SystemPrompt) error {
	if err := s.ready(); err != nil {
		return err
	}
	if !filepath.IsAbs(cwd) || len(extra) > 0 || prompt != nil {
		return acp.NewInvalidParams(map[string]any{"reason": "absolute cwd required; additional directories and client system prompts unsupported"})
	}
	p, err := configuration.Canonical(cwd)
	if err != nil || p != s.project {
		return acp.NewInvalidParams(map[string]any{"reason": "cwd differs from the configured process project"})
	}
	if !s.allowsProject(p) {
		return acpError("forbidden")
	}
	return nil
}
func (s *server) attach(id string, loading bool, identity ...string) *attachment {
	who := s.actor
	if len(identity) > 0 && identity[0] != "" {
		who = identity[0]
	}
	if s.principal != nil && s.principal.Actor.Rights != nil {
		rights := s.principal.Actor.Rights
		if snap, err := s.a.Snapshot(id); err == nil {
			rights = s.intersectRecorded(snap)
		}
		s.connectionRights.LoadOrStore(id, rights)
	}
	ctx, cancel := context.WithCancel(s.ctx)
	st := &attachment{actor: who, ctx: s.acting(ctx, id, who), cancel: cancel, loading: loading, streamed: map[string]bool{}, models: map[string]api.BufferedEvent{}, progress: map[string]api.BufferedEvent{}, requests: map[questionRecipient]context.CancelFunc{}, polled: map[questionRecipient]bool{}, joined: map[string]func(){}}
	st.disconnect = s.questions().Connect(id, who)
	s.mu.Lock()
	s.sessions[id] = st
	s.mu.Unlock()
	s.link(id)
	return st
}
func (s *server) detach(id string, st *attachment) bool {
	s.mu.Lock()
	delete(s.sessions, id)
	st.releaseBuffers()
	s.mu.Unlock()
	st.disconnect()
	s.connectionRights.Delete(id)
	for _, disconnect := range st.joined {
		disconnect()
	}
	st.cancel()
	last := s.unlink(id)
	if last {
		s.mcp().Remove(id)
	}
	return last
}
func (s *server) hostActor() api.Actor {
	host := s.principal.Actor
	if host.Rights == nil {
		host.Rights = api.Rights
	}
	return host
}
func convertServers(in []acp.McpServer) ([]mcptools.Server, error) {
	out := make([]mcptools.Server, 0, len(in))
	for _, v := range in {
		// Decode the SDK's validated discriminated union into a small local DTO.
		var p struct {
			Type, Name, Command, Url string
			Args                     []string
			Env                      []struct{ Name, Value string }
			Headers                  []struct{ Name, Value string }
		}
		if err := json.Unmarshal(api.JSON(v), &p); err != nil {
			return nil, err
		}
		spec := mcptools.Server{Name: p.Name, Command: p.Command, Args: p.Args, Env: map[string]string{}, Headers: map[string]string{}}
		switch p.Type {
		case "", "stdio":
		case "http":
			spec.URL = p.Url
		default:
			return nil, acp.NewInvalidParams(map[string]any{"reason": "unsupported MCP transport"})
		}
		for _, e := range p.Env {
			spec.Env[e.Name] = e.Value
		}
		for _, h := range p.Headers {
			spec.Headers[h.Name] = h.Value
		}
		out = append(out, spec)
	}
	return out, nil
}
func (s *server) NewSession(ctx context.Context, p acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	tenant, err := s.newTenant(p.Meta[Namespace])
	if err != nil {
		return acp.NewSessionResponse{}, err
	}
	if !s.hasRight("input") || len(p.McpServers) != 0 && !s.hasRight("tools") {
		return acp.NewSessionResponse{}, acpError("forbidden")
	}
	if s.projects != nil {
		host, err := s.projectHost(p.Cwd, "", p.AdditionalDirectories, p.SystemPrompt)
		if err != nil {
			return acp.NewSessionResponse{}, err
		}
		return host.NewSession(ctx, p)
	}
	lifecycle := s.sessionLifecycle()
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if err := s.root(p.Cwd, p.AdditionalDirectories, p.SystemPrompt); err != nil {
		return acp.NewSessionResponse{}, err
	}
	specs, err := convertServers(p.McpServers)
	if err != nil {
		return acp.NewSessionResponse{}, err
	}
	if s.resources.Settings != nil {
		var defaults api.Settings
		if v, e := s.a.Get("configuration"); e == nil {
			defaults, err = v.(api.Configuration).Settings(s.project)
		}
		if err == nil {
			defaults, err = s.resources.Settings(s.project, defaults)
		}
		if err != nil {
			return acp.NewSessionResponse{}, err
		}
		ctx = api.WithSessionSettings(ctx, defaults)
	}
	id, err := s.a.(actorSessions).NewForHost(s.acting(ctx, "", s.actor), p.Cwd, tenant, s.hostActor())
	if errors.Is(err, api.ErrTenantForbidden) {
		return acp.NewSessionResponse{}, acpError("forbidden")
	}
	if err != nil {
		return acp.NewSessionResponse{}, invalidActorRequest(err)
	}
	st := s.attach(id, false)
	err = s.mcp().Add(ctx, id, specs)
	if err == nil {
		err = s.addProjectMCP(ctx, id)
	}
	if err != nil {
		s.detach(id, st)
		_ = s.a.CloseSession(id)
		return acp.NewSessionResponse{}, err
	}
	opts, err := s.config(id)
	if err != nil {
		s.detach(id, st)
		_ = s.a.CloseSession(id)
		return acp.NewSessionResponse{}, err
	}
	return acp.NewSessionResponse{SessionId: acp.SessionId(id), ConfigOptions: opts, Meta: s.sessionMeta(ctx, id)}, nil
}

func (s *server) newTenant(raw json.RawMessage) (string, error) {
	var meta struct {
		Tenant *string `json:"tenant"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &meta) != nil {
		return "", acp.NewInvalidParams(nil)
	}
	tenant := ""
	if meta.Tenant != nil {
		tenant = *meta.Tenant
		if tenant == "" {
			return "", acp.NewInvalidParams(nil)
		}
	}
	if !s.allowsTenant(tenant) {
		return "", acpError("forbidden")
	}
	return tenant, nil
}

func (s *server) reopen(ctx context.Context, id, cwd string, servers []acp.McpServer, extra []string, prompt *acp.SystemPrompt, replay bool) (acp.LoadSessionResponse, error) {
	var result acp.LoadSessionResponse
	if err := s.root(cwd, extra, prompt); err != nil {
		return result, err
	}
	if st, err := s.attached(id); err == nil {
		if !s.authorize(id, st.actor, "watch") {
			return result, acpError("forbidden")
		}
		if len(servers) != 0 {
			return result, acpError("conflict")
		}
		return s.openReply(ctx, id, st.actor, replay)
	}
	list, err := s.a.List(s.project)
	if err != nil {
		return result, err
	}
	found := false
	for _, snap := range list {
		if snap.ID == id && s.discoverable(snap) {
			if s.principal.Actor.Rights != nil {
				s.connectionRights.Store(id, s.intersectRecorded(snap))
			}
			found = true
			break
		}
	}
	if !found {
		return result, acpError("forbidden")
	}
	if len(servers) != 0 && !s.hasRight("tools") {
		return result, acpError("forbidden")
	}
	_, alreadyOpen := s.a.Snapshot(id)
	if alreadyOpen == nil && (!s.authorize(id, s.actor, "watch") || len(servers) != 0) {
		return result, acpError("forbidden")
	}
	specs, err := convertServers(servers)
	if err != nil {
		return result, err
	}
	if alreadyOpen != nil || s.shared == nil {
		if err = s.mcp().Add(ctx, id, specs); err != nil {
			return result, err
		}
		if err = s.addProjectMCP(ctx, id); err != nil {
			s.mcp().Remove(id)
			return result, err
		}
	}
	st := s.attach(id, true)
	if alreadyOpen != nil {
		if err = s.a.(actorSessions).OpenForHost(st.ctx, id, s.hostActor()); err != nil {
			s.detach(id, st)
			if held := heldError(err); held != nil {
				return result, held
			}
			return result, acpError("forbidden")
		}
	}
	result, err = s.openReply(ctx, id, st.actor, replay)
	if err != nil {
		s.detach(id, st)
		return result, err
	}
	if replay {
		epoch, e := s.erasureEpoch(id)
		if e != nil {
			return result, e
		}
		snap, e := s.historyView(st.ctx, id)
		if e != nil {
			if s.detach(id, st) {
				_ = s.a.StopSession(id)
			}
			return result, e
		}
		for _, entry := range snap.Branch() {
			if gate, ok := s.a.(outputGate); ok {
				e, err := gate.OutputValue(st.ctx, api.Event{Kind: "history.added", Session: id, Data: api.JSON(entry)})
				if err != nil {
					continue
				}
				entry = api.Decode[api.Entry](e.Data)
			}
			if current, err := s.erasureEpoch(id); err != nil || current != epoch {
				return result, api.ErrErasureUnavailable
			}
			s.replayEntry(withDeliveryEpoch(st.ctx, epoch), id, entry)
		}
		s.drainOpen(st, &snap)
	} else {
		s.drainOpen(st, nil)
	}
	return result, nil
}

func (s *server) drainOpen(st *attachment, snap *api.Session) {
	s.mu.Lock()
	pending := st.pending
	st.pending = nil
	st.loading = false
	s.mu.Unlock()
	for _, buffered := range pending {
		e := buffered.Event
		if snap == nil || !represented(*snap, e) {
			s.event(e)
		}
		buffered.Release()
	}
}

func (s *server) openReply(ctx context.Context, id, who string, replay bool) (acp.LoadSessionResponse, error) {
	opts, err := s.config(id)
	result := acp.LoadSessionResponse{ConfigOptions: opts, Meta: s.sessionMeta(ctx, id)}
	if err != nil {
		return result, err
	}
	method := "session/resume"
	if replay {
		method = "session/load"
	}
	gated, err := s.gateAnswer(s.acting(ctx, id, who), id, method, result)
	if err != nil {
		return acp.LoadSessionResponse{}, err
	}
	var reply acp.LoadSessionResponse
	if err := json.Unmarshal(api.JSON(gated), &reply); err != nil {
		return acp.LoadSessionResponse{}, api.ErrOutputWithheld
	}
	return reply, nil
}
func (s *server) LoadSession(ctx context.Context, p acp.LoadSessionRequest) (acp.LoadSessionResponse, error) {
	if s.projects != nil {
		host, err := s.projectHost(p.Cwd, string(p.SessionId), p.AdditionalDirectories, p.SystemPrompt)
		if err != nil {
			return acp.LoadSessionResponse{}, err
		}
		if host != s {
			return host.LoadSession(ctx, p)
		}
	}
	lifecycle := s.sessionLifecycle()
	if !lifecycle.TryLock() {
		return acp.LoadSessionResponse{}, acpError("busy")
	}
	defer lifecycle.Unlock()
	result, err := s.reopen(ctx, string(p.SessionId), p.Cwd, p.McpServers, p.AdditionalDirectories, p.SystemPrompt, true)
	return result, outputReplyError(err)
}
func (s *server) ResumeSession(ctx context.Context, p acp.ResumeSessionRequest) (acp.ResumeSessionResponse, error) {
	if s.projects != nil {
		host, err := s.projectHost(p.Cwd, string(p.SessionId), p.AdditionalDirectories, p.SystemPrompt)
		if err != nil {
			return acp.ResumeSessionResponse{}, err
		}
		if host != s {
			return host.ResumeSession(ctx, p)
		}
	}
	lifecycle := s.sessionLifecycle()
	if !lifecycle.TryLock() {
		return acp.ResumeSessionResponse{}, acpError("busy")
	}
	defer lifecycle.Unlock()
	result, err := s.reopen(ctx, string(p.SessionId), p.Cwd, p.McpServers, p.AdditionalDirectories, p.SystemPrompt, false)
	return acp.ResumeSessionResponse{ConfigOptions: result.ConfigOptions, Meta: result.Meta}, outputReplyError(err)
}
func (s *server) CloseSession(ctx context.Context, p acp.CloseSessionRequest) (acp.CloseSessionResponse, error) {
	if host := s.sessionHost(string(p.SessionId)); host != s {
		return host.CloseSession(ctx, p)
	}
	if err := s.ready(); err != nil {
		return acp.CloseSessionResponse{}, err
	}
	lifecycle := s.sessionLifecycle()
	if !lifecycle.TryLock() {
		return acp.CloseSessionResponse{}, acpError("busy")
	}
	defer lifecycle.Unlock()
	id := string(p.SessionId)
	st, err := s.requireAttachment(id)
	if err != nil {
		return acp.CloseSessionResponse{}, err
	}
	if s.principal != nil {
		snap, err := s.a.Snapshot(id)
		if err != nil || !s.permitsMembership(snap) {
			return acp.CloseSessionResponse{}, acpError("forbidden")
		}
	}
	if closer, ok := s.a.(interface {
		CloseFor(context.Context, string) error
	}); ok {
		err = closer.CloseFor(s.acting(ctx, id, st.actor), id)
	} else {
		err = s.a.CloseSession(id)
	}
	if errors.Is(err, api.ErrCloseForbidden) {
		return acp.CloseSessionResponse{}, acpError("forbidden")
	}
	s.detach(id, st)
	return acp.CloseSessionResponse{}, err
}
func (s *server) ListSessions(ctx context.Context, p acp.ListSessionsRequest) (acp.ListSessionsResponse, error) {
	if err := s.ready(); err != nil {
		return acp.ListSessionsResponse{}, err
	}
	if p.Cursor != nil {
		return acp.ListSessionsResponse{}, acp.NewInvalidParams(map[string]any{"reason": "list is not paginated"})
	}
	project := s.project
	if s.projects != nil {
		project = ""
		if p.Cwd != nil {
			if !filepath.IsAbs(*p.Cwd) {
				return acp.ListSessionsResponse{}, acp.NewInvalidParams(nil)
			}
			var err error
			project, err = configuration.Canonical(*p.Cwd)
			if err != nil {
				return acp.ListSessionsResponse{}, acp.NewInvalidParams(nil)
			}
		}
	} else if p.Cwd != nil {
		if err := s.root(*p.Cwd, nil, nil); err != nil {
			return acp.ListSessionsResponse{}, err
		}
	}
	if project != "" && !s.allowsProject(project) {
		return acp.ListSessionsResponse{}, acpError("forbidden")
	}
	list, err := s.a.List(project)
	if err != nil {
		return acp.ListSessionsResponse{}, err
	}
	out := acp.ListSessionsResponse{Sessions: []acp.SessionInfo{}}
	for _, snap := range list {
		if snap.Parent != "" || !s.discoverable(snap) {
			continue
		}
		host := s.sessionHost(snap.ID)
		// ACP has no executor route. It never claims a different Interface's calls.
		waiting, err := s.listingAPI(snap).WaitingForHost(host.acting(ctx, snap.ID, s.actor), snap, s.hostActor(), api.WaitingRoute{})
		if errors.Is(err, api.ErrAuthority) {
			continue
		}
		if err != nil {
			return acp.ListSessionsResponse{}, outputReplyError(err)
		}
		info := acp.SessionInfo{SessionId: acp.SessionId(snap.ID), Cwd: snap.Project,
			Meta: map[string]json.RawMessage{Namespace: api.JSON(map[string]any{"waiting": waiting})}}
		if len(snap.Entries) > 0 {
			info.UpdatedAt = acp.Ptr(snap.Entries[len(snap.Entries)-1].Time.Format("2006-01-02T15:04:05Z"))
		}
		out.Sessions = append(out.Sessions, info)
	}
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].SessionId < out.Sessions[j].SessionId })
	return out, nil
}
func (s *server) Cancel(ctx context.Context, p acp.CancelNotification) error {
	if host := s.sessionHost(string(p.SessionId)); host != s {
		return host.Cancel(ctx, p)
	}
	if _, err := s.attached(string(p.SessionId)); err != nil {
		return err
	}
	s.mu.Lock()
	st := s.sessions[string(p.SessionId)]
	var cancels []context.CancelFunc
	if st != nil {
		for _, cancel := range st.requests {
			cancels = append(cancels, cancel)
		}
	}
	s.mu.Unlock()
	if st == nil || !s.authorize(string(p.SessionId), st.actor, "cancel") {
		return acpError("forbidden")
	}
	err := s.a.CancelAs(s.acting(ctx, string(p.SessionId), st.actor), string(p.SessionId))
	for _, cancel := range cancels {
		cancel()
	}
	return err
}
func (s *server) sessionMeta(ctx context.Context, id string) map[string]json.RawMessage {
	return map[string]json.RawMessage{Namespace: api.JSON(map[string]any{"declaration": s.declaration(id)})}
}
