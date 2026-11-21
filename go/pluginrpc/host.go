package pluginrpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Spec struct {
	Serve                         func(context.Context, io.ReadCloser, io.Writer) error `json:"-"`
	Command                       []string                                              `json:"command,omitempty"`
	Env                           map[string]string                                     `json:"env,omitempty"`
	Config                        object                                                `json:"config"`
	URL                           string                                                `json:"url,omitempty"`
	TokenFile                     string                                                `json:"tokenFile,omitempty"`
	PingInterval, ControlDeadline time.Duration                                         `json:"-"`
	envKeys                       map[string]json.RawMessage
}

func (s *Spec) UnmarshalJSON(b []byte) error {
	type spec Spec
	if err := json.Unmarshal(b, (*spec)(s)); err != nil {
		return err
	}
	return json.Unmarshal(b, &s.envKeys)
}

type host struct {
	h                 *harness.Harness
	a                 api.API
	project           string
	toolsMu           sync.Mutex
	jobOwnersMu       sync.RWMutex
	jobOwners         map[string]*remote
	legacyCommandArgs bool
}
type remote struct {
	host      *host
	a         api.API
	peer      *Peer
	cmd       *exec.Cmd
	stdin     interface{ Close() error }
	exited    chan struct{}
	reg       Registration
	sources   map[string]*remoteSource
	closeOnce sync.Once
	active    atomic.Bool
	inOutput  atomic.Int32
	deadline  time.Duration
}
type work struct {
	session, actor, provider string
	model                    string
	runtime                  *runtimeWork
	call                     api.Call
	progress                 func(string)
	event                    func(api.Part)
	attempt                  *providerAttempt
	questions                *atomic.Int64
}
type workKey struct{}

func withWork(ctx context.Context, w work) context.Context {
	if w.questions == nil {
		w.questions = &atomic.Int64{}
	}
	return context.WithValue(ctx, workKey{}, w)
}

// LoadEnvironment starts the configured subprocesses after local plugins. It is
// used by every vanilla Harness, including terminal, ACP and HTTP composition.
func LoadEnvironment(h *harness.Harness, project, home string) error {
	specs, err := EnvironmentSpecs()
	if err != nil {
		return err
	}
	return load(context.Background(), h, project, home, specs, true)
}

// EnvironmentSpecs parses the operator's configured programs without starting them.
func EnvironmentSpecs() ([]Spec, error) {
	raw := os.Getenv("MODULAR_AGENT_PLUGINS")
	if raw == "" {
		return nil, nil
	}
	var specs []Spec
	if err := json.Unmarshal([]byte(raw), &specs); err != nil || specs == nil {
		return nil, fmt.Errorf("MODULAR_AGENT_PLUGINS must be an array of plugin specs: %v", err)
	}
	return specs, nil
}

// Load starts the given programs in order. The caller owns the Harness and
// must close it if loading any program fails.
func Load(ctx context.Context, h *harness.Harness, project, home string, specs []Spec) error {
	return load(ctx, h, project, home, specs, false)
}

func load(ctx context.Context, h *harness.Harness, project, home string, specs []Spec, legacyCommandArgs bool) error {
	if len(specs) == 0 {
		return nil
	}
	for _, spec := range specs {
		_, hasURL := spec.envKeys["url"]
		if spec.URL != "" || hasURL {
			if _, command := spec.envKeys["command"]; command || spec.Command != nil || spec.Serve != nil {
				return errors.New("plugin entry cannot name both a command and a service")
			}
			if _, env := spec.envKeys["env"]; env || spec.Env != nil {
				return errors.New("plugin service cannot name a process environment")
			}
			if spec.URL == "" || !filepath.IsAbs(spec.TokenFile) || spec.PingInterval < 0 || spec.ControlDeadline < 0 {
				return errors.New("invalid plugin service URL, tokenFile or deadline")
			}
		} else if _, token := spec.envKeys["tokenFile"]; token || spec.TokenFile != "" {
			return errors.New("tokenFile requires a plugin service URL")
		} else if spec.Serve == nil && (len(spec.Command) == 0 || spec.Command[0] == "") {
			return errors.New("plugin command is empty")
		}
	}
	project, err := filepath.Abs(project)
	if err != nil {
		return err
	}
	project, err = filepath.EvalSymlinks(project)
	if err != nil {
		return err
	}
	home, err = filepath.Abs(home)
	if err != nil {
		return err
	}
	bridge := &host{h: h, project: project, jobOwners: map[string]*remote{}, legacyCommandArgs: legacyCommandArgs}
	if err = h.Load(bridge.plugin()); err != nil {
		return err
	}
	for i, spec := range specs {
		state := filepath.Join(home, "plugins", strconv.Itoa(i))
		if err = os.MkdirAll(state, 0700); err != nil {
			return err
		}
		r := &remote{host: bridge, exited: make(chan struct{}), sources: map[string]*remoteSource{}}
		if spec.Serve != nil {
			hostConn, pluginConn := net.Pipe()
			r.stdin = hostConn
			r.peer = NewPeer(hostConn, hostConn)
			go func() {
				defer close(r.exited)
				defer pluginConn.Close()
				_ = spec.Serve(context.Background(), pluginConn, pluginConn)
			}()
		} else if spec.URL != "" {
			if err := r.startService(ctx, spec); err != nil {
				return err
			}
		} else if err := r.startProcess(spec, project, legacyCommandArgs); err != nil {
			return err
		}
		r.peer.Handle = r.callback
		r.peer.notify = r.notification
		r.peer.admitNotification = r.admitNotification
		r.peer.requestBarrier = hostRequestBarrier
		r.peer.OnClose = func() { r.active.Store(false); _ = r.Close() }
		go func() {
			_ = r.peer.Run()
			if r.cmd != nil {
				_ = r.cmd.Wait()
				close(r.exited)
			} else if spec.URL != "" {
				r.peer.Close()
				close(r.exited)
			}
		}()
		init := object{"binding": Binding, "data": DataBinding, "host": object{"name": "modular-agent-go", "version": "1"}, "project": project, "home": state, "config": spec.Config}
		if spec.Config == nil {
			init["config"] = object{}
		}
		initCtx := ctx
		cancelInit := func() {}
		if r.deadline > 0 {
			initCtx, cancelInit = context.WithTimeout(ctx, r.deadline)
		}
		err = r.peer.Call(initCtx, "plugin/initialize", init, &r.reg)
		cancelInit()
		if err != nil {
			_ = r.Close()
			return err
		}
		err = r.validate()
		if err == nil && (r.reg.Name == "harness" || h.HasLocalPlugin(r.reg.Name) || bridge.registeredPlugin(r.reg.Name) != nil) {
			err = errors.New("duplicate plugin name: " + r.reg.Name)
		}
		if err == nil {
			err = h.LoadExternal(r.plugin(i), r.reg.Replaces)
		}
		if err != nil {
			r.shutdown("refused", err.Error())
			problem := object{"plugin": r.reg.Name, "where": "plugin.initialize", "message": err.Error()}
			bridge.a.Emit(context.Background(), api.Event{Kind: "plugin.problem", Data: mustJSON(problem)})
			return fmt.Errorf("plugin %s refused: %w", r.reg.Name, err)
		}
		bridge.jobOwnersMu.Lock()
		bridge.jobOwners[r.reg.Name] = r
		r.active.Store(true)
		bridge.jobOwnersMu.Unlock()
		select {
		case <-r.peer.Done():
			r.active.Store(false)
			return fault("lost", "plugin disconnected during registration")
		default:
		}
	}
	return nil
}
func (r *remote) startProcess(spec Spec, project string, legacyCommandArgs bool) error {
	r.cmd = exec.Command(spec.Command[0], spec.Command[1:]...)
	r.cmd.Dir = project
	r.cmd.Stderr = os.Stderr
	env := map[string]string{}
	minimal := []string{"PATH"}
	if legacyCommandArgs {
		minimal = append(minimal, "LANG", "LC_ALL", "TZ", "TMPDIR")
	}
	for _, key := range minimal {
		if value, ok := os.LookupEnv(key); ok {
			env[key] = value
		}
	}
	for k, v := range spec.Env {
		env[k] = v
	}
	r.cmd.Env = []string{}
	for k, v := range env {
		r.cmd.Env = append(r.cmd.Env, k+"="+v)
	}
	in, err := r.cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := r.cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return err
	}
	r.stdin = in
	if err = r.cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return err
	}
	r.peer = NewPeer(out, in)
	return nil
}
func (r *remote) Close() error {
	r.shutdown("stop", "")
	return nil
}
func (r *remote) shutdown(reason, detail string) {
	r.closeOnce.Do(func() {
		select {
		case <-r.exited:
			return
		default:
		}
		deadline := r.deadline
		if deadline == 0 {
			deadline = time.Second // existing stdio behavior
		}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		defer cancel()
		params := object{"reason": reason}
		if detail != "" {
			params["detail"] = detail
		}
		_ = r.peer.Call(ctx, "plugin/shutdown", params, nil)
		_ = r.stdin.Close()
		timer := time.NewTimer(deadline)
		defer timer.Stop()
		select {
		case <-r.exited:
		case <-timer.C:
			if r.cmd != nil {
				_ = r.cmd.Process.Kill()
			}
			r.peer.Close()
			<-r.exited
		}
	})
}
func (r *remote) validate() error {
	if r.reg.Binding != Binding {
		return fault("not_supported", "unsupported plugin binding")
	}
	if r.reg.Name == "" {
		return fault("invalid_request", "missing plugin name")
	}
	ids := map[string]bool{}
	for _, p := range r.reg.Providers {
		if p.ID == "" || ids["provider:"+p.ID] {
			return fault("invalid_request", "duplicate or empty provider")
		}
		ids["provider:"+p.ID] = true
		for _, m := range p.Models {
			if str(m, "provider") != p.ID || str(m, "id") == "" {
				return fault("invalid_request", "invalid model identity")
			}
		}
	}
	for _, s := range r.reg.ToolSources {
		if s.ID == "" || ids["source:"+s.ID] {
			return fault("invalid_request", "duplicate or empty tool source")
		}
		ids["source:"+s.ID] = true
		for _, t := range s.Tools {
			if str(t, "name") == "" || ids["tool:"+str(t, "name")] {
				return fault("invalid_request", "duplicate or empty tool")
			}
			ids["tool:"+str(t, "name")] = true
		}
	}
	for _, h := range r.reg.Hooks {
		if _, ok := hookNames[h.Hook]; !ok {
			return fault("not_supported", "unsupported hook "+h.Hook)
		}
		if h.Order != "first" && h.Order != "normal" && h.Order != "last" && h.Order != "" {
			return fault("invalid_request", "invalid hook order")
		}
	}
	if e := r.reg.Environment; e != nil {
		if e.Containment != "strong" && e.Containment != "processGroup" && e.Containment != "none" {
			return fault("invalid_request", "invalid containment")
		}
	}
	for _, c := range r.reg.Commands {
		if c.Name == "" || ids["command:"+c.Name] {
			return fault("invalid_request", "duplicate or empty command")
		}
		ids["command:"+c.Name] = true
	}
	if r.reg.Runtime != nil {
		if r.reg.Runtime.ID == "" {
			return fault("invalid_request", "empty Runtime id")
		}
		ids["runtime"] = true
		if !slices.Contains(r.reg.Replaces, "runtime") {
			r.reg.Replaces = append(r.reg.Replaces, "runtime")
		}
	}
	for _, item := range r.reg.Replaces {
		if !ids[item] && item != "working-environment" {
			return fault("invalid_request", "replacement was not registered: "+item)
		}
		if item == "working-environment" && r.reg.Environment == nil {
			return fault("invalid_request", "replacement environment missing")
		}
	}
	return nil
}
func (r *remote) ownsProvider(id string) bool {
	for _, p := range r.reg.Providers {
		if p.ID == id {
			return true
		}
	}
	return false
}

func (r *remote) plugin(index int) api.Plugin {
	return api.Plugin{Name: fmt.Sprintf("stdio-%d-%s", index, r.reg.Name), Close: r.Close, Setup: func(a api.API) error {
		r.a = a
		if r.reg.Runtime != nil {
			if err := a.Provide("runtime", &remoteRuntime{remote: r}); err != nil {
				return err
			}
			for name, rule := range api.RuntimeHooks() {
				if err := a.Define(name, rule); err != nil {
					return err
				}
			}
		}
		for _, p := range r.reg.Providers {
			provider := &remoteProvider{remote: r, reg: p}
			if err := a.Provide("provider."+p.ID, provider); err != nil {
				return err
			}
		}
		for _, s := range r.reg.ToolSources {
			source := &remoteSource{remote: r, reg: s, lists: map[string][]api.Tool{}}
			r.sources[s.ID] = source
			if err := a.Provide(fmt.Sprintf("tools.stdio.%d.%s", index, s.ID), source); err != nil {
				return err
			}
		}
		if r.reg.Environment != nil {
			reg := r.reg.Environment
			containment := "none"
			if slices.Contains(reg.Platforms, runtimePlatform()) {
				containment = reg.Containment
			}
			env := &remoteEnvironment{peer: r.peer, project: r.host.project, containment: containment, points: reg.Points, confinesFiles: reg.ConfinesFiles}
			if err := a.Provide("working-environment", env); err != nil {
				return err
			}
			for _, point := range []string{"session.stop", "session.end"} {
				if err := a.Handle(point, "last", func(ctx context.Context, v any) (api.Decision, error) {
					return api.Decision{}, env.SessionEnded(ctx, v.(string))
				}); err != nil {
					return err
				}
			}
		}
		for _, h := range r.reg.Hooks {
			order := h.Order
			if order == "normal" {
				order = ""
			}
			if err := a.Handle(hookNames[h.Hook], order, r.handler(h)); err != nil {
				return err
			}
		}
		for _, c := range r.reg.Commands {
			if err := a.RegisterCommand(c.Name, func(ctx context.Context, id string, args []string) (string, error) {
				var result struct {
					Output string `json:"output"`
				}
				var wireArgs any = strings.Join(args, " ")
				if r.host.legacyCommandArgs {
					wireArgs = args
				}
				err := r.call(withWork(ctx, work{session: id, actor: api.Acting(ctx)}), "command/run", object{"name": c.Name, "args": wireArgs, "sessionId": id, "actorId": api.Acting(ctx)}, &result)
				return result.Output, err
			}); err != nil {
				return err
			}
		}
		return nil
	}}
}
func (r *remote) call(ctx context.Context, method string, params any, out any) error {
	return r.callTrackingTools(ctx, method, params, out, false)
}

// Only a request's own stream pieces delay delivery of its reply. Job
// progress, emitted events and refreshes may all call back on this connection.
func (r *remote) admitNotification(ctx context.Context, m envelope) (string, bool) {
	if !r.active.Load() {
		return "", false
	}
	parent := capturedParent(ctx)
	switch m.Method {
	case "host/jobs/progress":
		return jobProgressKey(m.Params), true
	case "host/emit":
		// Capture permission to use a live parent at receipt, not after
		// the emitter's reply has had time to cancel the parent context.
		if has(obj(m.Params), "parentRequestId") && (!parent.ok || parent.ctx.Err() != nil) {
			return "", false
		}
		return "", r.inOutput.Load() == 0
	case "host/problem":
		return "", true
	case "tools/changed":
		// A scoped invalidation only registers work here. Its caller will
		// refresh after receiving the reply, possibly a nested hook reply.
		if v := obj(m.Params); has(v, "parentRequestId") {
			r.registerToolChange(ctx, v)
			return "", false
		}
		return "", true
	case "provider/event":
		if parent.method != "provider/request" {
			return "", false
		}
		w, _ := parent.ctx.Value(workKey{}).(work)
		return parent.key, w.event != nil && w.attempt != nil && w.attempt.canStream()
	case "host/runtime/report":
		switch parent.method {
		case "runtime/runTurn", "runtime/resumeTurn", "runtime/continueOpenCalls":
			return parent.key, true
		}
	case "tools/progress":
		return parent.key, parent.method == "tools/call"
	case "env/output":
		return parent.key, parent.method == "env/exec"
	}
	return "", false
}

func jobProgressKey(raw json.RawMessage) string {
	var p struct{ JobID string }
	_ = json.Unmarshal(raw, &p)
	if p.JobID == "" {
		return ""
	}
	return "job:" + p.JobID
}

func hostRequestBarrier(ctx context.Context, m envelope) string {
	switch m.Method {
	case "host/jobs/end", "host/jobs/resume":
		// Validate and deliver progress received before the job changes state.
		return jobProgressKey(m.Params)
	case "host/hook":
		if str(obj(m.Params), "hook") == "provider.response" {
			// The response callback closes the Provider's stream grant.
			parent := capturedParent(ctx)
			if parent.method == "provider/request" {
				return parent.key
			}
		}
	}
	return ""
}

func (r *remote) notification(ctx context.Context, method string, raw json.RawMessage) {
	if !r.active.Load() {
		return
	}
	v := obj(raw)
	if method == "host/jobs/progress" {
		_, _ = r.jobCallback(ctx, method, v, true)
		return
	}
	if method == "tools/changed" {
		r.toolsChanged(ctx, v)
		return
	}
	if method == "host/emit" {
		kind, session := str(v, "type"), str(v, "sessionId")
		if !strings.Contains(kind, ".") || session == "" {
			return
		}
		var w work
		if has(v, "parentRequestId") {
			parent, ok := r.peer.requestParent(ctx, mustJSON(v["parentRequestId"]))
			if !ok {
				return
			}
			w, _ = parent.Value(workKey{}).(work)
			if w.runtime != nil || w.session != session {
				return
			}
		}
		if w.actor != "" && !r.host.a.Authorize(session, w.actor, "watch") {
			return
		}
		if _, err := r.host.a.Snapshot(session); err == nil {
			r.a.Emit(ctx, api.Event{Kind: "plugin." + r.reg.Name + "." + kind, Session: session, Actor: w.actor, Call: w.call.ID, Data: mustJSON(v["data"])})
		}
		return
	}
	if method == "host/problem" {
		if _, err := r.callback(ctx, method, raw); err != nil {
			r.host.a.Emit(ctx, api.Event{Kind: "plugin.problem", Data: mustJSON(err.Error())})
		}
		return
	}
	ctx, ok := r.peer.requestParent(ctx, mustJSON(v["parentRequestId"]))
	if !ok {
		return
	}
	w, _ := ctx.Value(workKey{}).(work)
	switch method {
	case "host/runtime/report":
		if w.runtime != nil {
			w.runtime.report(ctx, v)
		}
	case "tools/progress":
		content := contentIn(v["content"])
		if !api.ToolProgress(ctx, content) && w.progress != nil {
			w.progress(content.Text())
		}
	case "env/output":
		if fn, _ := ctx.Value(progressKey{}).(func(string)); fn != nil {
			fn(str(v, "chunk"))
		}
	case "provider/event":
		if w.event != nil {
			e := asObject(v["event"])
			kind := str(e, "type")
			if kind == "text" || kind == "reasoning" || kind == "toolInput" {
				part := api.Part{Type: kind, Text: str(e, "delta")}
				if id := str(e, "toolCallId"); id != "" {
					part.Wire = mustJSON(object{"type": kind, "text": part.Text, "toolCallId": id})
				}
				w.event(part)
			}
		}
	}
}
func (r *remote) callback(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	callbackID := RequestID(ctx)
	v := obj(raw)
	if strings.HasPrefix(method, "host/jobs/") {
		return r.jobCallback(ctx, method, v, false)
	}
	if method != "host/problem" && method != "host/credentials/read" && method != "host/hook" &&
		method != "host/declaration" && method != "host/session" && method != "host/history" &&
		method != "host/ask" && !isEnvironmentMethod(method, "host/") &&
		!strings.HasPrefix(method, "host/runtime/") && method != "host/tools/list" && method != "host/tools/call" {
		return nil, unknownMethod(method)
	}
	if !r.active.Load() {
		return nil, fault("invalid_request", "plugin is not loaded")
	}
	if strings.HasPrefix(method, "host/runtime/") {
		return r.runtimeCallback(ctx, method, v)
	}
	hasParent := has(v, "parentRequestId")
	hasSession := has(v, "sessionId")
	if hasSession && str(v, "sessionId") == "" {
		return nil, fault("invalid_request", "invalid session id")
	}
	switch method {
	case "host/problem", "host/credentials/read":
		if hasParent || hasSession {
			return nil, fault("invalid_request", "request is not about a session or parent")
		}
	case "host/ask", "host/hook", "host/env/read", "host/env/write", "host/env/exists", "host/env/exec", "host/env/list", "host/tools/list", "host/tools/call":
		if !hasParent {
			return nil, fault("invalid_request", "parent request is required")
		}
	}
	if method == "host/problem" {
		r.host.a.Emit(ctx, api.Event{Kind: "plugin.problem", Data: mustJSON(object{"plugin": r.reg.Name, "where": v["where"], "message": v["message"]})})
		return object{}, nil
	}
	if method == "host/credentials/read" {
		if !r.ownsProvider(str(v, "provider")) {
			return nil, fault("invalid_request", "provider is not owned by plugin")
		}
		var credential any
		if value, err := r.host.a.Get("credentials"); err == nil {
			secret, err := value.(api.Credentials).Get(ctx, str(v, "provider"))
			if err != nil {
				return nil, err
			}
			if secret != "" {
				credential = object{"type": "apiKey", "key": secret}
			}
		}
		return object{"credential": credential}, nil
	}
	var w work
	session := str(v, "sessionId")
	if hasParent {
		parent, ok := r.peer.requestParent(ctx, mustJSON(v["parentRequestId"]))
		if !ok {
			return nil, fault("invalid_request", "parent request is not active")
		}
		w, _ = parent.Value(workKey{}).(work)
		if w.runtime != nil && method != "host/history" {
			return nil, fault("invalid_request", "Runtime work may only use Runtime ports and history")
		}
		if session != "" && session != w.session {
			return nil, fault("invalid_request", "session differs from parent work")
		}
		session = w.session
		linked, cancel := context.WithCancel(parent)
		defer cancel()
		stop := context.AfterFunc(ctx, cancel)
		defer stop()
		if ctx.Err() != nil {
			cancel()
		}
		ctx = linked
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if w.actor != "" {
			ctx = api.AsActor(ctx, w.actor)
		}
		if session != "" && !r.host.a.Authorize(session, w.actor, "watch") {
			return nil, fault("invalid_request", "parent actor cannot access session")
		}
	}
	if method == "host/tools/list" || method == "host/tools/call" {
		if w.call.ID == "" {
			return nil, fault("invalid_request", "tool invocation is required")
		}
		tools := api.InvocationTools(ctx)
		if tools == nil {
			return nil, fault("not_supported", "host does not run nested calls")
		}
		if method == "host/tools/list" {
			list, err := tools.List(ctx)
			if err != nil {
				return nil, fault("invalid_request", err.Error())
			}
			wire := make([]object, 0, len(list))
			for _, t := range list {
				wire = append(wire, toolOut(t))
			}
			return object{"tools": wire}, nil
		}
		if str(v, "name") == "" || !has(v, "input") {
			return nil, fault("invalid_request", "name and input are required")
		}
		result, err := tools.Call(ctx, str(v, "name"), mustJSON(v["input"]))
		if err != nil {
			return nil, err
		}
		return resultOut(result), nil
	}
	if method == "host/hook" {
		if w.provider == "" || (str(v, "hook") != "provider.request" && str(v, "hook") != "provider.response") {
			return nil, fault("invalid_request", "hook is not owned by this work")
		}
		if !r.ownsProvider(w.provider) {
			return nil, fault("invalid_request", "provider is not owned by plugin")
		}
		payload := asObject(v["payload"])
		model := asObject(payload["model"])
		if str(payload, "provider") != w.provider || str(model, "provider") != w.provider || str(model, "id") != w.model {
			return nil, fault("invalid_request", "provider or model differs from parent")
		}
		if str(payload, "sessionId") != session || (has(payload, "sessionId") && str(payload, "sessionId") == "") {
			return nil, fault("invalid_request", "hook session differs from parent")
		}
		if w.attempt == nil {
			return nil, fault("invalid_request", "no active Provider attempt")
		}
		return w.attempt.hook(ctx, r.host, str(v, "hook"), payload)
	}
	if method == "host/declaration" && session == "" {
		return acpinterface.Declaration(r.host.a, r.host.project, ""), nil
	}
	if session == "" {
		return nil, fault("invalid_request", "session required")
	}
	snap, err := r.host.a.Snapshot(session)
	if err != nil {
		return nil, fault("invalid_request", "session is not open")
	}
	switch method {
	case "host/session":
		busy, _ := r.host.h.Busy(session)
		actors := []api.Actor{}
		for _, a := range snap.Actors {
			actors = append(actors, a)
		}
		return object{"id": snap.ID, "project": snap.Project, "settings": snap.Settings, "busy": busy, "actors": actors}, nil
	case "host/declaration":
		return acpinterface.Declaration(r.host.a, r.host.project, session), nil
	case "host/history":
		return HistoryPage(snap, v)
	case "host/ask":
		if w.session == "" || w.questions == nil {
			return nil, fault("invalid_request", "question needs parent work")
		}
		if !r.host.a.Authorize(session, w.actor, "tools") {
			return nil, fault("invalid_request", "parent actor cannot ask")
		}
		request := asObject(v["request"])
		if str(request, "whenTimeLimit") == "leaveOpen" {
			policy, ok := r.host.a.(interface{ LateQuestions() bool })
			if ok && !policy.LateQuestions() {
				return nil, fault("not_supported", "leaving a call open is not supported")
			}
		}
		execution := api.Executing(ctx)
		q := api.Question{Wire: mustJSON(request), Details: mustJSON(request["details"]), Session: session, Turn: execution.Turn, Call: w.call.ID, Actor: w.actor, Kind: str(request, "kind"), Prompt: str(request, "question"), Credential: str(request, "credential"), Key: str(request, "key"), Wait: time.Duration(number(request, "timeLimitMs")) * time.Millisecond, Defer: str(request, "whenTimeLimit") == "leaveOpen"}
		_ = json.Unmarshal(mustJSON(request["options"]), &q.Options)
		value, err := r.host.a.Get("questions")
		if err != nil {
			return nil, err
		}
		answer, err := value.(api.Questions).Ask(ctx, q)
		if errors.Is(err, api.ErrQuestionOpen) {
			return object{"pending": true}, nil
		}
		var declined *api.QuestionDeclined
		if errors.As(err, &declined) {
			return object{"requestId": declined.Request, "actorId": w.actor, "declined": true, "reason": declined.Reason}, nil
		}
		if err != nil && q.Kind == "secret" && strings.Contains(err.Error(), "secret destination unavailable") {
			return object{"requestId": api.ID(), "actorId": w.actor, "declined": true, "reason": "secret destination unavailable"}, nil
		}
		if err != nil {
			return nil, err
		}
		if q.Kind == "secret" {
			return object{"requestId": answer.Request, "actorId": answer.Actor, "stored": answer.Stored, "declined": answer.Declined, "reason": answer.Reason}, nil
		}
		return object{"requestId": answer.Request, "actorId": answer.Actor, "value": answer.Value, "declined": answer.Declined, "reason": answer.Reason}, nil
	}
	if isEnvironmentMethod(method, "host/") {
		if !hasSession || w.session == "" || !r.host.a.Authorize(session, w.actor, "tools") {
			return nil, fault("invalid_request", "environment needs authorized parent work")
		}
		cwd := str(v, "cwd")
		rel, err := filepath.Rel(snap.Project, cwd)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fault("invalid_request", "cwd is outside session project")
		}
		value, err := r.host.a.Get("working-environment")
		if err != nil {
			return nil, fault("lost", "working environment unavailable")
		}
		return environmentRequest(ctx, value.(api.WorkingEnvironment), method, v, func(chunk string) {
			_ = r.peer.Send("host/env/output", object{"parentRequestId": callbackID, "chunk": chunk})
		})
	}
	return nil, unknownMethod(method)
}
