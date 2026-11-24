package pluginrpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
	"github.com/daniel-ballance/modular-agent/go/local"
	"github.com/daniel-ballance/modular-agent/go/tools"
	"github.com/daniel-ballance/modular-agent/go/turnrun"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

type Registration struct {
	Binding     string                   `json:"binding"`
	Name        string                   `json:"name"`
	Providers   []ProviderRegistration   `json:"providers,omitempty"`
	ToolSources []SourceRegistration     `json:"toolSources,omitempty"`
	Environment *EnvironmentRegistration `json:"workingEnvironment,omitempty"`
	Hooks       []HookRegistration       `json:"hooks,omitempty"`
	Commands    []CommandRegistration    `json:"commands,omitempty"`
	Runtime     *RuntimeRegistration     `json:"runtime,omitempty"`
	Replaces    []string                 `json:"replaces,omitempty"`
}
type ProviderRegistration struct {
	ID       string `json:"id"`
	Supports struct {
		KeepsState bool `json:"keepsState"`
		RunsTools  bool `json:"runsTools"`
	} `json:"supports"`
	Models []object `json:"models"`
}
type SourceRegistration struct {
	ID         string   `json:"id"`
	Tools      []object `json:"tools"`
	PerSession bool     `json:"perSession"`
}
type EnvironmentRegistration struct {
	Points        bool     `json:"points"`
	Containment   string   `json:"containment"`
	Platforms     []string `json:"platforms,omitempty"`
	ConfinesFiles bool     `json:"confinesFiles,omitempty"`
}
type HookRegistration struct {
	Hook  string `json:"hook"`
	ID    int    `json:"handlerId"`
	Order string `json:"order"`
}
type CommandRegistration struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Server exposes normal Go capabilities, not a second agent loop. Handlers use
// shared-data payloads; providers and tool sources use their ordinary contracts.
type Server struct {
	Registration Registration
	Providers    map[string]api.Provider
	Sources      map[string]api.ToolSource
	Runtime      api.Runtime
	Environment  api.WorkingEnvironment
	Handlers     map[int]func(context.Context, string, object) (any, error)
	Commands     map[string]func(context.Context, object) (any, error)
	JobCancel    api.JobCanceller
	Initialize   func(object) error
	// Projects and RequireEnvironmentScope are trusted listener settings.
	Projects                []string
	RequireEnvironmentScope bool
	peer                    *Peer
	service                 bool
	mu                      sync.Mutex
	initialized             bool
	project                 string // canonical project for environment requests
	stopping                bool
	envMu                   sync.Mutex
	ownedEnv                api.WorkingEnvironment
	envClosed               bool
}

func (s *Server) Serve(ctx context.Context, in io.ReadCloser, out io.Writer) error {
	return s.serve(ctx, NewPeer(in, out))
}

// ServeServiceConnection serves one instance on an already-authenticated connection.
func (s *Server) ServeServiceConnection(ctx context.Context, conn *wswire.Conn) error {
	s.service = true
	p := newMessagePeer(conn)
	p.afterResponse = func(method string) {
		if method == "plugin/shutdown" {
			conn.CloseNormal()
		}
	}
	return s.serve(ctx, p)
}

func (s *Server) serve(ctx context.Context, p *Peer) error {
	if s.Initialize == nil {
		s.ownedEnv = s.Environment
	}
	s.peer = p
	p.Handle = func(call context.Context, method string, raw json.RawMessage) (any, error) {
		return s.handle(call, method, raw)
	}
	p.admitNotification = func(ctx context.Context, m envelope) (string, bool) {
		parent := capturedParent(ctx)
		switch m.Method {
		case "host/runtime/modelEvent":
			return parent.key, parent.method == "host/runtime/model"
		case "host/env/output":
			return parent.key, parent.method == "host/env/exec"
		default:
			return "", false
		}
	}
	p.notify = func(ctx context.Context, method string, raw json.RawMessage) {
		if method == "host/runtime/modelEvent" {
			v := obj(raw)
			if parent, ok := p.requestParent(ctx, mustJSON(v["parentRequestId"])); ok {
				if fn, _ := parent.Value(modelEventKey{}).(func(api.Part)); fn != nil {
					e := asObject(v["event"])
					fn(api.Part{Type: str(e, "type"), Text: str(e, "delta")})
				}
			}
		}
		if method == "host/env/output" {
			v := obj(raw)
			if parent, ok := p.requestParent(ctx, mustJSON(v["parentRequestId"])); ok {
				if fn, _ := parent.Value(progressKey{}).(func(string)); fn != nil {
					fn(str(v, "chunk"))
				}
			}
		}
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			p.Close()
		case <-done:
		}
	}()
	// Stdin EOF can end a whole process. A service instead cancels and
	// joins this connection's handlers before destroying its instance.
	err := p.run(s.service)
	p.Close()
	s.closeEnvironment()
	if s.service {
		p.wait.Wait()
	}
	return err
}

func providerAvailable(p api.Provider) bool { ready, _ := providerAvailability(p); return ready }
func providerAvailability(p api.Provider) (bool, string) {
	if a, ok := p.(interface{ Availability() (bool, string) }); ok {
		return a.Availability()
	}
	a, ok := p.(interface{ Available() bool })
	return !ok || a.Available(), ""
}

// ProviderCredential uses the host-owned credential handed to this Provider.
func (s *Server) ProviderCredential(ctx context.Context, provider string) (string, error) {
	var reply struct{ Credential *struct{ Type, Key string } }
	if err := s.peer.Call(ctx, "host/credentials/read", object{"provider": provider}, &reply); err != nil {
		return "", err
	}
	if reply.Credential == nil || reply.Credential.Type != "apiKey" {
		return "", nil
	}
	return reply.Credential.Key, nil
}

func (s *Server) Callback(ctx context.Context, method string, params Object, out any) error {
	id := RequestID(ctx)
	if len(id) == 0 || ctx.Err() != nil {
		return fault("invalid_request", "no active request")
	}
	params["parentRequestId"] = id
	return s.peer.Call(ctx, method, params, out)
}

// Notify sends a notification on behalf of the current served handler.
func (s *Server) Notify(ctx context.Context, method string, params Object) error {
	id := RequestID(ctx)
	if len(id) == 0 || ctx.Err() != nil {
		return fault("invalid_request", "no active request")
	}
	params["parentRequestId"] = id
	return s.peer.sendWork(ctx, method, params)
}

// Project is the canonical project supplied during initialization.
func (s *Server) Project() string { return s.project }

// JobCall makes an independent owner callback.
func (s *Server) JobCall(ctx context.Context, method string, p Object, out any) error {
	return s.peer.Call(ctx, method, p, out)
}
func (s *Server) JobNotify(method string, p Object) error {
	return s.JobNotifyContext(context.Background(), method, p)
}

// JobNotifyContext sends job progress with the current observation context.
func (s *Server) JobNotifyContext(ctx context.Context, method string, p Object) error {
	return s.peer.sendWork(ctx, method, p)
}

// ToolsChanged announces a changed catalog, optionally within its causing request.
func (s *Server) ToolsChanged(ctx context.Context, id string) error {
	params := Object{"toolSource": id}
	if request := RequestID(ctx); len(request) != 0 {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		params["parentRequestId"] = request
	}
	return s.peer.sendWork(ctx, "tools/changed", params)
}

func (s *Server) ownEnvironment(env api.WorkingEnvironment) {
	s.envMu.Lock()
	if !s.envClosed {
		s.ownedEnv = env
		s.envMu.Unlock()
		return
	}
	s.envMu.Unlock()
	if env != nil {
		_ = env.Close()
	}
}

func (s *Server) closeEnvironment() {
	s.envMu.Lock()
	env := s.ownedEnv
	s.ownedEnv = nil
	s.envClosed = true
	s.envMu.Unlock()
	if env != nil {
		_ = env.Close()
	}
}

func (s *Server) handle(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	v := obj(raw)
	s.mu.Lock()
	if method == "plugin/initialize" {
		defer s.mu.Unlock()
		if s.initialized {
			return nil, fault("invalid_request", "already initialized")
		}
		if str(v, "binding") != Binding {
			return nil, fault("not_supported", "unsupported binding or data version")
		}
		if !filepath.IsAbs(str(v, "project")) || !filepath.IsAbs(str(v, "home")) {
			return nil, fault("invalid_request", "project and home must be absolute")
		}
		if s.service && s.Projects != nil && !slices.Contains(s.Projects, str(v, "project")) {
			return nil, fault("invalid_request", "project is outside the service scope")
		}
		if s.Initialize != nil {
			err := s.Initialize(v)
			s.ownEnvironment(s.Environment)
			if err != nil {
				return nil, err
			}
		}
		s.project = str(v, "project")
		if s.Environment != nil {
			if s.service && s.RequireEnvironmentScope && s.Projects == nil {
				return nil, fault("not_supported", "working environment requires operator project scope")
			}
			project, err := filepath.EvalSymlinks(s.project)
			if err != nil || !cwdInProject(project, project) || (s.service && project != str(v, "project")) {
				code := "invalid_request"
				if s.service {
					code = "not_supported"
				}
				return nil, fault(code, "working environment requires the same absolute project directory")
			}
			s.project = project
		}
		s.initialized = true
		reg := s.Registration
		s.peer.traceName.Store(&reg.Name)
		return reg, nil
	}
	ready := s.initialized && !s.stopping
	if method == "plugin/shutdown" && s.initialized {
		s.stopping = true
		s.mu.Unlock()
		s.closeEnvironment()
		return object{}, nil
	}
	s.mu.Unlock()
	if ready && strings.HasPrefix(method, "runtime/") && s.Runtime != nil {
		return s.runRuntime(ctx, method, v)
	}
	if !ready {
		return nil, fault("invalid_request", "plugin is not initialized or is stopping")
	}
	id := RequestID(ctx)
	switch method {
	case "tools/list":
		source, ok := s.Sources[str(v, "toolSource")]
		if !ok {
			return nil, fault("invalid_request", "unknown tool source")
		}
		list := []any{}
		for _, t := range source.Tools(api.Session{ID: str(v, "sessionId")}) {
			list = append(list, toolOut(t))
		}
		return object{"tools": list}, nil
	case "tools/call":
		source, ok := s.Sources[str(v, "toolSource")]
		if !ok {
			return nil, fault("invalid_request", "unknown tool source")
		}
		call := callIn(asObject(v["call"]))
		known := false
		for _, def := range source.Tools(api.Session{ID: str(v, "sessionId"), Project: str(v, "project")}) {
			if def.Name == call.Name {
				known = true
				if !api.CanCall(def, call.Origin) {
					return object{"status": "refused", "content": contentOut(api.Text("tool does not allow this caller"))}, nil
				}
				break
			}
		}
		if !known {
			return nil, fault("invalid_request", "tool is not registered by this source")
		}
		if str(v, "sessionId") == "" {
			return nil, fault("invalid_request", "sessionId is required")
		}
		ctx = api.WithExecution(ctx, api.Execution{Session: str(v, "sessionId"), Call: call})
		progress := func(content api.Content) {
			_ = s.peer.sendWork(ctx, "tools/progress", object{"parentRequestId": id, "content": contentOut(content)})
		}
		ctx = api.WithToolProgress(ctx, progress)
		ctx = api.WithNestedTools(ctx, servedTools{s: s, ctx: ctx})
		project := s.project
		r := source.Run(ctx, api.Session{ID: str(v, "sessionId"), Project: project}, call, func(chunk string) {
			progress(api.Text(chunk))
		})
		if r.Status == "open" {
			return object{"pending": "waiting for an answer"}, nil
		}
		result := resultOut(r)
		delete(result, "callId")
		return result, nil
	case "provider/models", "provider/available", "provider/discard", "provider/request":
		provider, ok := s.Providers[str(v, "provider")]
		if !ok {
			return nil, fault("invalid_request", "unknown provider")
		}
		if method == "provider/models" {
			list := []any{}
			for _, m := range provider.Catalog() {
				if m.Provider == "" {
					m.Provider = str(v, "provider")
				}
				list = append(list, modelOut(m))
			}
			return object{"models": list}, nil
		}
		if method == "provider/available" {
			ready, reason := providerAvailability(provider)
			out := object{"available": ready}
			if !ready && reason != "" {
				out["reason"] = reason
			}
			return out, nil
		}
		if method == "provider/discard" {
			session := str(v, "sessionId")
			if session == "" {
				return nil, fault("invalid_request", "sessionId is required")
			}
			erase := boolean(v, "erase")
			if has(v, "erase") {
				if _, ok := v["erase"].(bool); !ok {
					return nil, fault("invalid_request", "erase must be a boolean")
				}
			}
			if erase {
				values, ok := v["entryIds"].([]any)
				if !ok {
					return nil, fault("invalid_request", "entryIds is required for erasure")
				}
				entryIDs := make([]string, 0, len(values))
				for _, value := range values {
					id, ok := value.(string)
					if !ok || id == "" {
						return nil, fault("invalid_request", "entryIds must contain entry identities")
					}
					entryIDs = append(entryIDs, id)
				}
				if eraser, ok := provider.(api.ProviderEraser); ok {
					return eraser.EraseState(ctx, session, entryIDs)
				}
				for _, registered := range s.Registration.Providers {
					if registered.ID == str(v, "provider") && registered.Supports.KeepsState {
						return nil, fault("not_supported", "Provider cannot erase remote state")
					}
				}
			}
			if d, ok := provider.(interface {
				Discard(context.Context, string) error
			}); ok {
				return object{}, d.Discard(ctx, session)
			}
			return object{}, nil
		}
		m := asObject(v["model"])
		if str(m, "provider") != str(v, "provider") {
			return nil, fault("invalid_request", "model belongs to another provider")
		}
		nativeID := ""
		for _, candidate := range provider.Catalog() {
			if candidate.ID == str(m, "id") || candidate.ID == str(m, "provider")+"/"+str(m, "id") {
				nativeID = candidate.ID
				break
			}
		}
		if nativeID == "" {
			return nil, fault("invalid_request", "unknown model")
		}
		access, err := provider.Access(nativeID)
		if err != nil {
			return nil, fault("invalid_request", err.Error())
		}
		payload := object{"sessionId": v["sessionId"], "provider": v["provider"], "model": m, "request": v["request"]}
		var prepared object
		if err = s.peer.Call(ctx, "host/hook", object{"parentRequestId": id, "hook": "provider.request", "payload": payload}, &prepared); err != nil {
			return nil, err
		}
		var msg object
		if has(prepared, "refused") {
			msg = object{"role": "assistant", "content": []any{}, "stop": "failed", "error": object{"kind": "refused", "message": prepared["refused"]}}
		} else {
			ctx = api.WithExecution(ctx, api.Execution{Session: str(v, "sessionId")})
			request := requestIn(asObject(prepared["request"]))
			request.Thinking = api.LowerReasoning(request.Thinking, access.Model().Thinking)
			response, err := access.Generate(ctx, request, func(part api.Part) {
				if ctx.Err() != nil {
					return
				}
				event := object{"type": part.Type, "delta": part.Text}
				if callID := str(obj(part.Wire), "toolCallId"); callID != "" {
					event["toolCallId"] = callID
				}
				_ = s.peer.sendWork(ctx, "provider/event", object{"parentRequestId": id, "event": event})
			})
			if ctx.Err() != nil || errors.Is(err, context.Canceled) || Code(err) == "cancelled" {
				return nil, fault("cancelled", "Provider request cancelled")
			}
			msg = responseOut(response)
			if err != nil {
				msg["stop"] = "failed"
				msg["error"] = errorOut(err)
			}
		}
		if ctx.Err() != nil {
			return nil, fault("cancelled", "Provider request cancelled")
		}
		if err = s.peer.Call(ctx, "host/hook", object{"parentRequestId": id, "hook": "provider.response", "payload": providerResponsePayload(payload, msg)}, nil); err != nil {
			return nil, err
		}
		return msg, nil
	case "env/sessionEnded":
		if s.Environment == nil {
			return nil, fault("invalid_request", "not the working environment")
		}
		if str(v, "sessionId") == "" {
			return nil, fault("invalid_request", "sessionId is required")
		}
		return object{}, endEnvironmentSession(ctx, s.Environment, str(v, "sessionId"))
	case "env/save", "env/checkPoint", "env/restore":
		if s.Registration.Environment == nil || !s.Registration.Environment.Points || s.Environment == nil {
			return nil, fault("not_supported", "working environment does not support points")
		}
		return pointRequest(ctx, s.Environment, s.project, method, v)
	case "env/read", "env/write", "env/exists", "env/exec", "env/list":
		if s.Environment == nil {
			return nil, fault("invalid_request", "not the working environment")
		}
		if !cwdInProject(s.project, str(v, "cwd")) {
			return nil, fault("invalid_request", "cwd must resolve within the initialized project")
		}
		if s.service && method != "env/exec" && !pathInProject(s.project, str(v, "cwd"), str(v, "path")) {
			return nil, fault("invalid_request", "path must resolve within the initialized project")
		}
		return environmentRequest(ctx, s.Environment, method, v, func(chunk string) {
			_ = s.peer.sendWork(ctx, "env/output", object{"parentRequestId": id, "chunk": chunk})
		})
	case "hook/handle":
		if str(v, "hook") == "output" {
			v = parseOutput(raw)
		}
		fn, ok := s.Handlers[number(v, "handlerId")]
		if !ok {
			return nil, fault("unknown_handler", "unknown handler")
		}
		return fn(ctx, str(v, "hook"), asObject(v["payload"]))
	case "jobs/cancel":
		if s.JobCancel == nil {
			return nil, fault("invalid_request", "no job owner registered")
		}
		return object{}, s.JobCancel(ctx, str(v, "jobId"))
	case "command/run":
		fn, ok := s.Commands[str(v, "name")]
		if !ok {
			return nil, fault("invalid_request", "unknown command")
		}
		return fn(ctx, v)
	}
	return nil, unknownMethod(method)
}
func isEnvironmentMethod(method, prefix string) bool {
	return method == prefix+"env/read" || method == prefix+"env/write" || method == prefix+"env/exists" || method == prefix+"env/exec" || method == prefix+"env/list"
}

func endEnvironmentSession(ctx context.Context, env api.WorkingEnvironment, session string) error {
	if end, ok := env.(interface {
		SessionEnded(context.Context, string) error
	}); ok {
		return end.SessionEnded(ctx, session)
	}
	return nil
}

func environmentRequest(ctx context.Context, env api.WorkingEnvironment, method string, v object, progress func(string)) (any, error) {
	execution := api.Executing(ctx)
	execution.Session = str(v, "sessionId")
	if execution.Session == "" {
		return nil, fault("invalid_request", "sessionId is required")
	}
	ctx = api.WithExecution(ctx, execution)
	cwd, path := str(v, "cwd"), str(v, "path")
	if !filepath.IsAbs(cwd) {
		return nil, fault("invalid_request", "cwd must be absolute")
	}
	switch strings.TrimPrefix(method, "host/") {
	case "env/read":
		b, err := env.Read(ctx, cwd, path)
		if errors.Is(err, fs.ErrNotExist) && Code(err) == "" {
			err = fault("not_found", err.Error())
		}
		return object{"data": base64.StdEncoding.EncodeToString(b)}, err
	case "env/write":
		b, err := base64.StdEncoding.DecodeString(str(v, "data"))
		if err != nil {
			return nil, fault("invalid_request", "invalid base64")
		}
		return object{}, env.Write(ctx, cwd, path, b)
	case "env/list":
		lister, ok := env.(api.DirectoryLister)
		if !ok {
			return nil, fault("not_supported", "environment does not list directories")
		}
		if path == "" {
			return nil, fault("invalid_request", "path is required")
		}
		entries, err := lister.ListDir(ctx, cwd, path)
		if err != nil {
			switch {
			case Code(err) != "":
				return nil, err
			case errors.Is(err, fs.ErrNotExist):
				return nil, fault("not_found", err.Error())
			case errors.Is(err, fs.ErrInvalid), errors.Is(err, fs.ErrPermission):
				return nil, fault("invalid_request", err.Error())
			default:
				return nil, err
			}
		}
		if entries == nil {
			entries = []api.DirEntry{}
		}
		return object{"entries": entries}, nil
	case "env/exists":
		if e, ok := env.(interface {
			Exists(context.Context, string, string) (bool, error)
		}); ok {
			exists, err := e.Exists(ctx, cwd, path)
			return object{"exists": exists}, err
		}
		_, err := env.Read(ctx, cwd, path)
		if errors.Is(err, fs.ErrNotExist) {
			return object{"exists": false}, nil
		}
		return object{"exists": err == nil}, err
	case "env/exec":
		var timeout time.Duration
		if _, present := v["timeoutMs"]; present {
			n, ok := v["timeoutMs"].(json.Number)
			ms, err := n.Float64()
			if !ok || err != nil || ms <= 0 || ms != float64(int64(ms)) || ms >= float64((1<<63-1)/time.Millisecond) {
				return nil, fault("invalid_request", "invalid timeoutMs")
			}
			timeout = time.Duration(ms * float64(time.Millisecond))
		}
		if e, ok := env.(api.Executor); ok {
			return e.Exec(ctx, cwd, str(v, "command"), timeout, progress)
		}
		if timeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, timeout)
			defer cancel()
		}
		output, err := env.Bash(ctx, cwd, str(v, "command"), progress)
		r := api.ExecResult{Output: output, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded)}
		if r.TimedOut {
			return r, nil
		}
		if err == nil {
			code := 0
			r.ExitCode = &code
		}
		return r, err
	}
	return nil, unknownMethod(method)
}

type progressKey struct{}

// HostEnvironment exposes environment callbacks to an SDK tool invocation.
func (s *Server) HostEnvironment() api.WorkingEnvironment {
	return &remoteEnvironment{peer: s.peer, prefix: "host/"}
}

type remoteEnvironment struct {
	peer          *Peer
	project       string
	prefix        string
	containment   string
	points        bool
	confinesFiles bool
}

func (e *remoteEnvironment) Containment() string { return e.containment }
func (e *remoteEnvironment) ConfinesFiles() bool { return e.confinesFiles }
func (e *remoteEnvironment) StopsOnCrash() bool  { return e.containment == "strong" }
func (e *remoteEnvironment) Close() error        { return nil }
func (e *remoteEnvironment) SessionEnded(ctx context.Context, session string) error {
	return e.peer.Call(ctx, "env/sessionEnded", object{"sessionId": session}, nil)
}
func (e *remoteEnvironment) request(ctx context.Context, method string, v object, out any) error {
	execution := api.Executing(ctx)
	if execution.Session == "" {
		return fault("invalid_request", "sessionId is required")
	}
	v["sessionId"] = execution.Session
	if e.project != "" && !cwdInProject(e.project, str(v, "cwd")) {
		return fault("invalid_request", "cwd must resolve within the initialized project")
	}
	if e.prefix == "" {
		ctx = withWork(ctx, work{session: execution.Session, actor: api.Acting(ctx), call: execution.Call})
	}
	if e.prefix == "host/" {
		v["parentRequestId"] = RequestID(ctx)
	}
	return e.peer.Call(ctx, e.prefix+method, v, out)
}
func (e *remoteEnvironment) ListDir(ctx context.Context, cwd, path string) ([]api.DirEntry, error) {
	var response struct{ Entries []api.DirEntry }
	err := e.request(ctx, "env/list", object{"cwd": cwd, "path": path}, &response)
	if Code(err) == "method_not_found" || Code(err) == "not_supported" {
		err = api.ErrListUnsupported
	}
	return response.Entries, err
}
func (e *remoteEnvironment) Exists(ctx context.Context, cwd, path string) (bool, error) {
	var v struct {
		Exists bool `json:"exists"`
	}
	err := e.request(ctx, "env/exists", object{"cwd": cwd, "path": path}, &v)
	return v.Exists, err
}
func (e *remoteEnvironment) Read(ctx context.Context, cwd, path string) ([]byte, error) {
	var v struct {
		Data string `json:"data"`
	}
	if err := e.request(ctx, "env/read", object{"cwd": cwd, "path": path}, &v); err != nil {
		if Code(err) == "method_not_found" || Code(err) == "not_supported" {
			return nil, errors.Join(errors.ErrUnsupported, err)
		}
		return nil, err
	}
	return base64.StdEncoding.DecodeString(v.Data)
}
func (e *remoteEnvironment) Write(ctx context.Context, cwd, path string, b []byte) error {
	return e.request(ctx, "env/write", object{"cwd": cwd, "path": path, "data": base64.StdEncoding.EncodeToString(b)}, nil)
}
func (e *remoteEnvironment) Exec(ctx context.Context, cwd, command string, timeout time.Duration, progress func(string)) (api.ExecResult, error) {
	var r api.ExecResult
	ctx = context.WithValue(ctx, progressKey{}, progress)
	v := object{"cwd": cwd, "command": command}
	if timeout > 0 {
		v["timeoutMs"] = float64(timeout) / float64(time.Millisecond)
	}
	err := e.request(ctx, "env/exec", v, &r)
	if Code(err) == "lost" {
		err = fmt.Errorf("%w: %w", api.ErrUnknownOutcome, err)
	}
	return r, err
}
func (e *remoteEnvironment) Bash(ctx context.Context, cwd, command string, progress func(string)) (string, error) {
	r, err := e.Exec(ctx, cwd, command, 0, progress)
	if err == nil {
		if r.ExitCode == nil {
			err = api.ErrUnknownOutcome
		} else if *r.ExitCode != 0 {
			err = fmt.Errorf("exit status %d", *r.ExitCode)
		}
	}
	return r.Output, err
}

// ConformanceServer serves existing tools, the existing echo Provider and local
// supervised execution. Tools always obtain the environment from the host.
func ConformanceServer() *Server { return conformanceServer("") }

// ListenConformancePlugin serves the same fixture as ConformanceServer, without
// trusting the host home path. The operator can assign one project and state directory.
func ListenConformancePlugin(ctx context.Context, address, tokenFile string) (*wswire.Server, error) {
	token, err := wswire.ReadToken(tokenFile)
	if err != nil {
		return nil, err
	}
	project, hasProject := os.LookupEnv("MODULAR_AGENT_PLUGIN_PROJECT")
	state, hasState := os.LookupEnv("MODULAR_AGENT_PLUGIN_STATE_DIR")
	var projects []string
	if hasProject || hasState {
		if !filepath.IsAbs(project) || !filepath.IsAbs(state) {
			return nil, errors.New("MODULAR_AGENT_PLUGIN_PROJECT and MODULAR_AGENT_PLUGIN_STATE_DIR must both be absolute")
		}
		project, err = filepath.EvalSymlinks(project)
		if err != nil || !cwdInProject(project, project) {
			return nil, errors.New("MODULAR_AGENT_PLUGIN_PROJECT must name a directory")
		}
		if err := os.MkdirAll(state, 0700); err != nil {
			return nil, err
		}
		projects = []string{project}
	}
	return wswire.Listen(ctx, address, nil, wswire.Plugin, map[string]struct{}{token: {}}, func(ctx context.Context, c *wswire.Conn, _ struct{}) {
		if state != "" {
			s := conformanceServer(state)
			s.Projects = projects
			_ = s.ServeServiceConnection(ctx, c)
			return
		}
		dir, err := os.MkdirTemp("", "go-conformance-plugin-")
		if err != nil {
			return
		}
		defer os.RemoveAll(dir)
		_ = conformanceServer(dir).ServeServiceConnection(ctx, c)
	})
}

func conformanceServer(serviceState string) *Server {
	s := &Server{Providers: map[string]api.Provider{}, Sources: map[string]api.ToolSource{}, Handlers: map[int]func(context.Context, string, object) (any, error){}}
	s.Initialize = func(init object) error {
		s.Registration = Registration{Binding: Binding, Name: "go-conformance"}
		parts, explicit := os.LookupEnv("MODULAR_AGENT_PLUGIN_PARTS")
		if !explicit {
			parts = "provider,tools,environment,hooks"
		}
		chosen := map[string]bool{}
		for _, part := range strings.Split(parts, ",") {
			if chosen[part] {
				return fault("invalid_request", "duplicate conformance part")
			}
			switch part {
			case "provider", "tools", "environment", "hooks", "runtime", "durable-runtime":
				chosen[part] = true
			default:
				return fault("invalid_request", "unknown conformance part: "+part)
			}
		}
		if explicit {
			names := make([]string, 0, len(chosen))
			for name := range chosen {
				names = append(names, name)
			}
			slices.Sort(names)
			s.Registration.Name += "." + strings.Join(names, ".")
		}
		if chosen["runtime"] && chosen["durable-runtime"] {
			return fault("invalid_request", "only one Runtime may be served")
		}
		if chosen["runtime"] || chosen["durable-runtime"] {
			d := chosen["durable-runtime"]
			s.Runtime = &turnrun.Runner{Durable: d}
			name := "transient"
			if d {
				name = "durable"
			}
			s.Registration.Runtime = &RuntimeRegistration{ID: name, Supports: RuntimeSupports{InputDuringTurn: true, WaitingThroughRestart: d, ContinuesAfterRestart: d, InterfaceTools: s.Runtime.Declaration().InterfaceTools}}
			s.Registration.Replaces = append(s.Registration.Replaces, "runtime")
		}
		if chosen["provider"] {
			provider := conformancemodel.New()
			s.Providers["conformance"] = provider
			reg := ProviderRegistration{ID: "conformance"}
			for _, m := range provider.Catalog() {
				reg.Models = append(reg.Models, modelOut(m))
			}
			s.Registration.Providers = append(s.Registration.Providers, reg)
			s.Registration.Replaces = append(s.Registration.Replaces, "provider:conformance")
		}
		if chosen["tools"] {
			env := &remoteEnvironment{peer: s.peer, prefix: "host/"}
			source := &onlyTools{ToolSource: tools.New(func() (api.WorkingEnvironment, error) { return env, nil }), env: env}
			s.Sources["conformance-tools"] = source
			reg := SourceRegistration{ID: "conformance-tools"}
			for _, t := range source.Tools(api.Session{}) {
				reg.Tools = append(reg.Tools, toolOut(t))
			}
			s.Registration.ToolSources = append(s.Registration.ToolSources, reg)
			s.Registration.Replaces = append(s.Registration.Replaces, "tool:bash", "tool:read", "tool:nest")
		}
		if chosen["environment"] {
			home := str(init, "home")
			if serviceState != "" {
				home = serviceState
			}
			environment := local.NewAt(filepath.Join(home, "commands"))
			s.Environment = environment
			containment := environment.Containment()
			_, points := api.Points(s.Environment)
			s.Registration.Environment = &EnvironmentRegistration{Containment: containment, Platforms: environment.Platforms(), Points: points}
			s.Registration.Replaces = append(s.Registration.Replaces, "working-environment")
		}
		if chosen["hooks"] {
			s.Registration.Hooks = []HookRegistration{{Hook: "tool.before", ID: 1, Order: "normal"}, {Hook: "turn.before", ID: 2, Order: "normal"}, {Hook: "output", ID: 3, Order: "normal"}}
			s.Handlers[3] = redactOutput
			s.Handlers[1] = func(ctx context.Context, hook string, v object) (any, error) {
				if hook != "tool.before" {
					return nil, fault("unknown_handler", "hook does not match handler")
				}
				if strings.Contains(string(mustJSON(asObject(v["call"])["input"])), "conformance-forbidden") {
					return object{"refuse": "refused by the conformance plugin"}, nil
				}
				return nil, nil
			}
			s.Handlers[2] = func(ctx context.Context, hook string, v object) (any, error) {
				if hook != "turn.before" {
					return nil, fault("unknown_handler", "hook does not match handler")
				}
				return object{"system": "The conformance plugin is loaded."}, nil
			}
		}
		return nil
	}
	return s
}

type onlyTools struct {
	api.ToolSource
	env *remoteEnvironment
}

func (s *onlyTools) Run(ctx context.Context, session api.Session, call api.Call, progress func(string)) api.ToolResult {
	if call.Name == "nest" {
		return Nest(ctx, call)
	}
	if call.Name != "bash" {
		return s.ToolSource.Run(ctx, session, call, progress)
	}
	var input struct {
		Command *string `json:"command"`
	}
	if json.Unmarshal(call.Input, &input) != nil || input.Command == nil {
		return api.ToolResult{Status: "failed", Content: api.Text("command is required")}
	}
	executed, err := s.env.Exec(ctx, session.Project, *input.Command, 0, progress)
	if err != nil {
		status := "failed"
		if errors.Is(err, api.ErrUnknownOutcome) {
			status = "unknown"
		} else if ctx.Err() != nil {
			status = "cancelled"
		}
		return api.ToolResult{Status: status, Content: api.Text(err.Error())}
	}
	status, code := "failed", "null"
	if executed.ExitCode != nil {
		code = fmt.Sprint(*executed.ExitCode)
		if *executed.ExitCode == 0 {
			status = "completed"
		}
	}
	return api.ToolResult{Status: status, Content: api.Text(executed.Output + "\n[exit code " + code + "]")}
}

func (s *onlyTools) Tools(session api.Session) []api.Tool {
	out := []api.Tool{NestDefinition()}
	for _, t := range s.ToolSource.Tools(session) {
		if t.Name == "bash" || t.Name == "read" {
			out = append(out, t)
		}
	}
	return out
}
