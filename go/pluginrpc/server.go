package pluginrpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/conformancemodel"
	"github.com/OWNER/modular-agent/go/local"
	"github.com/OWNER/modular-agent/go/tools"
	"github.com/OWNER/modular-agent/go/turnrun"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
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
	Points      bool     `json:"points"`
	Containment string   `json:"containment"`
	Platforms   []string `json:"platforms"`
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
	Initialize   func(object) error
	peer         *Peer
	mu           sync.Mutex
	initialized  bool
	project      string // canonical project for environment requests
	stopping     bool
	envMu        sync.Mutex
	ownedEnv     api.WorkingEnvironment
	envClosed    bool
}

func (s *Server) Serve(ctx context.Context, in io.ReadCloser, out io.Writer) error {
	if s.Initialize == nil {
		s.ownedEnv = s.Environment
	}
	p := NewPeer(in, out)
	s.peer = p
	p.Handle = s.handle
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
	// Stdin closing ends the process even if a handler is still blocked.
	err := p.run(false)
	s.closeEnvironment()
	return err
}

// Callback sends a scoped request on behalf of the current served handler.
func (s *Server) Callback(ctx context.Context, method string, params Object, out any) error {
	id := RequestID(ctx)
	if len(id) == 0 || ctx.Err() != nil {
		return fault("invalid_request", "no active request")
	}
	params["parentRequestId"] = id
	return s.peer.Call(ctx, method, params, out)
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
		if str(v, "binding") != Binding || str(v, "data") != DataBinding {
			return nil, fault("not_supported", "unsupported binding or data version")
		}
		if !filepath.IsAbs(str(v, "project")) || !filepath.IsAbs(str(v, "home")) {
			return nil, fault("invalid_request", "project and home must be absolute")
		}
		if s.Initialize != nil {
			err := s.Initialize(v)
			s.ownEnvironment(s.Environment)
			if err != nil {
				return nil, err
			}
		}
		if s.Environment != nil {
			project, err := filepath.EvalSymlinks(str(v, "project"))
			if err != nil || !cwdInProject(project, project) {
				return nil, fault("invalid_request", "working environment project must resolve to a directory")
			}
			s.project = project
		}
		s.initialized = true
		return s.Registration, nil
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
		r := source.Run(ctx, api.Session{ID: str(v, "sessionId"), Project: str(v, "project")}, call, func(chunk string) {
			_ = s.peer.Send("tools/progress", object{"parentRequestId": id, "content": contentOut(api.Text(chunk))})
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
			return object{"available": true}, nil
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
			response, err := access.Generate(ctx, requestIn(asObject(prepared["request"])), func(part api.Part) {
				_ = s.peer.Send("provider/event", object{"parentRequestId": id, "event": object{"type": part.Type, "delta": part.Text}})
			})
			msg = responseOut(response)
			if err != nil {
				msg["stop"] = "failed"
				msg["error"] = errorOut(err)
			}
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
	case "env/read", "env/write", "env/exists", "env/exec":
		if s.Environment == nil {
			return nil, fault("invalid_request", "not the working environment")
		}
		if !cwdInProject(s.project, str(v, "cwd")) {
			return nil, fault("invalid_request", "cwd must resolve within the initialized project")
		}
		return environmentRequest(ctx, s.Environment, method, v, func(chunk string) { _ = s.peer.Send("env/output", object{"parentRequestId": id, "chunk": chunk}) })
	case "hook/handle":
		if str(v, "hook") == "output" {
			v = parseOutput(raw)
		}
		fn, ok := s.Handlers[number(v, "handlerId")]
		if !ok {
			return nil, fault("unknown_handler", "unknown handler")
		}
		return fn(ctx, str(v, "hook"), asObject(v["payload"]))
	case "command/run":
		fn, ok := s.Commands[str(v, "name")]
		if !ok {
			return nil, fault("unknown_handler", "unknown command")
		}
		return fn(ctx, v)
	}
	return nil, unknownMethod(method)
}
func isEnvironmentMethod(method, prefix string) bool {
	return method == prefix+"env/read" || method == prefix+"env/write" || method == prefix+"env/exists" || method == prefix+"env/exec"
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
		if has(v, "timeoutMs") {
			n, ok := v["timeoutMs"].(json.Number)
			ms, err := n.Float64()
			if !ok || err != nil || ms < 0 || ms >= float64((1<<63-1)/time.Millisecond) {
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
type remoteEnvironment struct {
	peer        *Peer
	project     string
	prefix      string
	containment string
	points      bool
}

func (e *remoteEnvironment) Containment() string { return e.containment }
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
func ConformanceServer() *Server {
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
			s.Registration.Runtime = &RuntimeRegistration{ID: name, Supports: RuntimeSupports{InputDuringTurn: true, WaitingThroughRestart: d, ContinuesAfterRestart: d}}
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
			s.Registration.Replaces = append(s.Registration.Replaces, "tool:bash", "tool:read")
		}
		if chosen["environment"] {
			s.Environment = local.NewAt(filepath.Join(str(init, "home"), "commands"))
			containment := "none"
			if s.Environment.StopsOnCrash() {
				containment = "strong"
			}
			_, points := api.Points(s.Environment)
			s.Registration.Environment = &EnvironmentRegistration{Containment: containment, Platforms: []string{runtime.GOOS}, Points: points}
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
	var out []api.Tool
	for _, t := range s.ToolSource.Tools(session) {
		if t.Name == "bash" || t.Name == "read" {
			out = append(out, t)
		}
	}
	return out
}
