package pluginrpc

import (
	"context"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"runtime"
	"strings"
	"sync"
	"time"
)

func runtimePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

type remoteProvider struct {
	remote    *remote
	reg       ProviderRegistration
	mu        sync.Mutex
	models    []object
	refreshed bool
}

func (p *remoteProvider) Catalog() []api.Model {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.catalogLocked()
}
func (p *remoteProvider) catalogLocked() []api.Model {
	out := []api.Model{}
	models := p.reg.Models
	if p.refreshed {
		models = p.models
	}
	for _, v := range models {
		m := modelIn(v)
		m.Stateful = p.reg.Supports.KeepsState
		m.RunsTools = p.reg.Supports.RunsTools
		out = append(out, m)
	}
	return out
}
func (p *remoteProvider) RefreshCatalog(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var out struct{ Models []object }
	err := p.remote.call(ctx, "provider/models", object{"provider": p.reg.ID}, &out)
	p.models, p.refreshed = nil, true
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, m := range out.Models {
		id := str(m, "id")
		if id == "" || str(m, "provider") != p.reg.ID || seen[id] {
			return fault("invalid_request", "invalid Provider catalog")
		}
		seen[id] = true
	}
	p.models = out.Models
	return nil
}

func (p *remoteProvider) Available() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out struct{ Available bool }
	return p.remote.call(ctx, "provider/available", object{"provider": p.reg.ID}, &out) == nil && out.Available
}

func (p *remoteProvider) Access(id string) (api.ModelAccess, error) {
	for _, m := range p.Catalog() {
		if m.ID == id {
			return &remoteAccess{p: p, model: m}, nil
		}
	}
	return nil, fmt.Errorf("unknown model %s", id)
}
func (p *remoteProvider) Discard(ctx context.Context, session string) error {
	return p.remote.call(withWork(ctx, work{session: session, actor: api.Acting(ctx)}), "provider/discard", object{"provider": p.reg.ID, "sessionId": session}, nil)
}

func (p *remoteProvider) EraseState(ctx context.Context, session string, entryIDs []string) (api.ProviderErasure, error) {
	var report api.ProviderErasure
	err := p.remote.call(withWork(ctx, work{session: session, actor: api.Acting(ctx)}), "provider/discard", object{"provider": p.reg.ID, "sessionId": session, "erase": true, "entryIds": entryIDs}, &report)
	return report, err
}

type remoteAccess struct {
	p     *remoteProvider
	model api.Model
}

func (a *remoteAccess) Model() api.Model        { return a.model }
func (a *remoteAccess) UsesFinalModelDispatch() {}
func (a *remoteAccess) Generate(ctx context.Context, request api.Request, emit func(api.Part)) (api.Response, error) {
	e := api.Executing(ctx)
	model := strings.TrimPrefix(a.model.ID, a.p.reg.ID+"/")
	fence := api.FinalDispatch(ctx)
	attempt := &providerAttempt{fence: fence, request: requestValue(request)}
	ctx = withWork(ctx, work{session: e.Session, actor: api.Acting(ctx), provider: a.p.reg.ID, model: model, event: emit, attempt: attempt})
	params := object{"provider": a.p.reg.ID, "model": object{"provider": a.p.reg.ID, "id": model}, "request": attempt.request}
	if e.Session != "" {
		params["sessionId"] = e.Session
	}
	var msg object
	err := a.p.remote.call(ctx, "provider/request", params, &msg)
	if err != nil {
		return api.Response{}, err
	}
	if !attempt.matches(msg) {
		return api.Response{}, fault("invalid_request", "Provider answer did not match its authorized response callback")
	}
	response := responseIn(msg)
	if response.Stop == "failed" {
		v := asObject(msg["error"])
		kind := str(v, "kind")
		if kind == "contextTooLarge" {
			kind = "context_too_large"
		}
		return response, &api.ModelError{Kind: kind, Message: str(v, "message")}
	}
	return response, nil
}

type remoteSource struct {
	remote *remote
	reg    SourceRegistration
	mu     sync.Mutex
	lists  map[string][]api.Tool
}

func (s *remoteSource) ToolSourceIdentity() (string, string) { return s.remote.reg.Name, s.reg.ID }

func (s *remoteSource) Tools(session api.Session) []api.Tool {
	if s.reg.PerSession && session.ID != "" {
		s.mu.Lock()
		_, ok := s.lists[session.ID]
		s.mu.Unlock()
		if !ok {
			if err := s.refresh(context.Background(), session.ID, false); err != nil {
				s.remote.host.a.Emit(context.Background(), api.Event{Kind: "plugin.problem", Session: session.ID, Data: mustJSON(err.Error())})
				return nil
			}
		}
	}
	return s.cachedTools(session.ID)
}

func (s *remoteSource) cachedTools(session string) []api.Tool {
	key := ""
	if s.reg.PerSession {
		key = session
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if list, ok := s.lists[key]; ok {
		return append([]api.Tool(nil), list...)
	}
	out := []api.Tool{}
	for _, v := range s.reg.Tools {
		out = append(out, stdioTool(v))
	}
	return out
}

func stdioTool(v object) api.Tool {
	t := toolIn(v)
	// The plugin binding routes tool work through the session's environment.
	// openWorld is a tool hint, not a declaration of a separate environment.
	t.UsesWorkingEnvironment = true
	return t
}

func (s *remoteSource) refresh(ctx context.Context, session string, invalidateOtherSessions bool) error {
	var response struct {
		Tools []object `json:"tools"`
	}
	params := object{"toolSource": s.reg.ID}
	if s.reg.PerSession {
		params["sessionId"] = session
	}
	ctx = withWork(ctx, work{session: session, actor: api.Acting(ctx)})
	if err := s.remote.peer.Call(ctx, "tools/list", params, &response); err != nil {
		return err
	}
	list := []api.Tool{}
	seen := map[string]bool{}
	for _, v := range response.Tools {
		t := stdioTool(v)
		if t.Name == "" || seen[t.Name] {
			return fault("invalid_request", "duplicate or empty changed tool")
		}
		seen[t.Name] = true
		list = append(list, t)
	}
	key := ""
	if s.reg.PerSession {
		key = session
	}
	// Check before publishing. Inspect cached lists of other remote sources
	// rather than recursively refreshing them.
	bridge := s.remote.host
	bridge.toolsMu.Lock()
	defer bridge.toolsMu.Unlock()
	for _, source := range bridge.a.All("tools.") {
		var other []api.Tool
		if remote, ok := source.(*remoteSource); ok {
			if remote == s {
				continue
			}
			other = remote.cachedTools(session)
		} else {
			other = source.(api.ToolSource).Tools(api.Session{ID: session})
		}
		for _, tool := range other {
			if seen[tool.Name] {
				return fault("invalid_request", "changed list has duplicate tool "+tool.Name)
			}
		}
	}
	s.mu.Lock()
	if invalidateOtherSessions {
		s.lists = map[string][]api.Tool{}
	}
	s.lists[key] = list
	s.mu.Unlock()
	return nil
}
func (s *remoteSource) Run(ctx context.Context, session api.Session, call api.Call, progress func(string)) api.ToolResult {
	actor := call.Actor
	if actor == "" {
		actor = api.Acting(ctx)
	}
	ctx = withWork(api.AsActor(ctx, actor), work{session: session.ID, actor: actor, call: call, progress: progress})
	var result object
	err := s.remote.call(ctx, "tools/call", object{"toolSource": s.reg.ID, "sessionId": session.ID, "project": session.Project, "call": callOut(call)}, &result)
	if err != nil {
		status := "failed"
		if Code(err) == "lost" {
			status = "unknown"
		} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || Code(err) == "cancelled" {
			status = "cancelled"
		}
		return api.ToolResult{Call: call.ID, Name: call.Name, Status: status, Content: api.Text(err.Error())}
	}
	r := resultIn(result)
	r.Call = call.ID
	r.Name = call.Name
	return r
}
