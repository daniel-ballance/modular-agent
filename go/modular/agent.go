// Package modular builds agents without exposing the underlying Harness.
package modular

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/OWNER/modular-agent/go/acpinterface"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/approval"
	"github.com/OWNER/modular-agent/go/commands"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/contextview"
	"github.com/OWNER/modular-agent/go/durable"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/local"
	"github.com/OWNER/modular-agent/go/mcptools"
	"github.com/OWNER/modular-agent/go/modelselect"
	"github.com/OWNER/modular-agent/go/pluginrpc"
	"github.com/OWNER/modular-agent/go/questions"
	"github.com/OWNER/modular-agent/go/transient"
)

const localActor = "user"

type Durability string

const (
	Ephemeral Durability = "ephemeral"
	Kept      Durability = "kept"
	Durable   Durability = "durable"
)

type Approval string

const (
	Off   Approval = "off"
	Ask   Approval = "ask"
	All   Approval = "all"
	Never Approval = "never"
)

type ProcessPlugin struct {
	Command []string          `json:"command"`
	Env     map[string]string `json:"env,omitempty"`
	Config  map[string]any    `json:"config,omitempty"`
}
type options struct {
	project, dataDir, model string
	durability              Durability
	providers               []Provider
	plugins                 []Plugin
	tools                   []Tool
	process                 []ProcessPlugin
	host                    *bool
	settings                Settings
	approval                Approval
	handler                 QuestionHandler
	history                 HistoryStore
}
type Option func(*options) error

func WithProject(p string) Option { return func(o *options) error { o.project = p; return nil } }
func WithDataDir(p string) Option { return func(o *options) error { o.dataDir = p; return nil } }
func WithModel(m string) Option   { return func(o *options) error { o.model = m; return nil } }
func WithDurability(d Durability) Option {
	return func(o *options) error { o.durability = d; return nil }
}
func WithProvider(p Provider) Option {
	return func(o *options) error { o.providers = append(o.providers, p); return nil }
}
func WithTool(t Tool) Option {
	return func(o *options) error { o.tools = append(o.tools, t); return nil }
}
func WithPlugin(p Plugin) Option {
	return func(o *options) error { o.plugins = append(o.plugins, p); return nil }
}
func WithProcessPlugin(p ProcessPlugin) Option {
	return func(o *options) error { o.process = append(o.process, p); return nil }
}
func WithPluginHost(host bool) Option { return func(o *options) error { o.host = &host; return nil } }
func WithSettings(s Settings) Option {
	return func(o *options) error {
		for k, v := range s {
			o.settings[k] = v
		}
		return nil
	}
}
func WithApproval(a Approval) Option {
	return func(o *options) error {
		if !validApproval(string(a)) {
			return &Error{Code: InvalidParams, Message: "invalid approval policy"}
		}
		o.approval = a
		return nil
	}
}
func OnQuestion(h QuestionHandler) Option { return WithOnQuestion(h) }
func WithOnQuestion(h QuestionHandler) Option {
	return func(o *options) error { o.handler = h; return nil }
}

type Agent struct {
	h          *harness.Harness
	a          api.API
	project    string
	scratch    string
	persistent bool
	closed     atomic.Bool
	lifecycle  sync.Mutex
	pluginHost bool
	q          *questionRouter
	closeOnce  sync.Once
	closeErr   error
}
type sessionDefaults struct{ settings *api.Settings }

func (s sessionDefaults) Settings(string) (api.Settings, error) { return *s.settings, nil }

func New(ctx context.Context, opts ...Option) (*Agent, error) {
	o := options{durability: Ephemeral, settings: Settings{}}
	for _, opt := range opts {
		if opt == nil {
			return nil, &Error{Code: InvalidParams, Message: "nil option"}
		}
		if err := opt(&o); err != nil {
			return nil, appError(err, InvalidParams)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if o.durability != Ephemeral && o.durability != Kept && o.durability != Durable {
		return nil, &Error{Code: InvalidParams, Message: "unknown durability"}
	}
	if o.history.serviceDir != "" {
		return nil, &Error{Code: InvalidComposition, Message: "use HTTPHistory to connect to a history service"}
	}
	if o.durability != Ephemeral && o.dataDir == "" && !o.history.persistent {
		return nil, &Error{Code: InvalidComposition, Message: "kept and durable require a data directory or persistent history"}
	}
	if o.durability != Ephemeral && o.history.make != nil && !o.history.persistent {
		return nil, &Error{Code: InvalidComposition, Message: "kept and durable require persistent history"}
	}
	project, err := configuration.Canonical(o.project)
	if err != nil {
		return nil, &Error{Code: InvalidParams, Message: err.Error()}
	}
	info, err := os.Stat(project)
	if err != nil || !info.IsDir() {
		return nil, &Error{Code: InvalidParams, Message: "project must be a directory"}
	}
	defaults := api.Settings{Thinking: "off", MaxSteps: 12, MaxOutput: 1024}
	for k, v := range o.settings {
		if err := applySetting(&defaults, k, v); err != nil {
			return nil, err
		}
	}
	if o.model != "" {
		if err := applySetting(&defaults, "model", o.model); err != nil {
			return nil, err
		}
	}
	if o.approval != "" {
		defaults.Approval = api.ApprovalInternal(string(o.approval))
	}
	host := len(o.process) > 0
	if o.host != nil {
		host = *o.host
	}
	var specs []pluginrpc.Spec
	for _, p := range o.process {
		specs = append(specs, pluginrpc.Spec{Command: p.Command, Env: p.Env, Config: p.Config})
	}
	if host {
		more, e := pluginrpc.EnvironmentSpecs()
		if e != nil {
			return nil, appError(e, InvalidComposition)
		}
		specs = append(specs, more...)
	}
	h := harness.NewWithLocalActor(localActor)
	h.HandBackQueuedOnOpen()
	a := &Agent{h: h, a: h.API(), project: project, pluginHost: host, persistent: o.durability != Ephemeral || o.history.persistent}
	state := o.dataDir
	if state == "" {
		state, err = os.MkdirTemp("", "modular-go-")
		if err != nil {
			return nil, appError(err, InvalidComposition)
		}
		a.scratch = state
	}
	success := false
	defer func() {
		if !success {
			_ = a.Close(context.Background())
		}
	}()
	state, err = filepath.Abs(state)
	if err != nil {
		return nil, appError(err, InvalidComposition)
	}
	runtime := transient.Plugin()
	if o.durability == Durable {
		runtime = durable.Plugin()
	}
	store := o.history.make
	if store == nil && o.durability == Ephemeral {
		store = MemoryHistory().make
	}
	if store == nil {
		store = FileHistory(filepath.Join(state, "sessions")).make
	}
	hs, err := store()
	if err != nil {
		return nil, appError(err, InvalidComposition)
	}
	historyPlugin := api.Plugin{Name: "history", Setup: func(a api.API) error { return a.Provide("history", hs) }}
	if closer, ok := hs.(io.Closer); ok {
		historyPlugin.Close = closer.Close
	}
	core := []api.Plugin{historyPlugin,
		{Name: "configuration", Setup: func(a api.API) error { return a.Provide("configuration", sessionDefaults{&defaults}) }},
		{Name: "sdk-credentials", Setup: func(a api.API) error { return a.Provide("credentials", environmentCredentials{}) }},
		configuration.BoundProject(project), local.ConfinedPluginAt(filepath.Join(state, "commands"), state), runtime,
		modelselect.Plugin(), contextview.Plugin(), commands.Plugin(), questions.Plugin(), mcptools.Plugin(nil, project), acpinterface.Plugin(project)}
	if o.approval != "" {
		core = append(core, approval.Plugin())
	}
	a.q = newQuestionRouter(a.a, o.handler)
	core = append(core, a.q.plugin())
	for _, p := range core {
		if err := h.Load(p); err != nil {
			return nil, appError(err, InvalidComposition)
		}
	}
	own := make([]Plugin, 0, len(o.providers)+len(o.tools)+len(o.plugins))
	for _, p := range o.providers {
		own = append(own, Plugin{Name: p.ID, Setup: func(r *Registrar) error { return r.Provider(p) }})
	}
	for _, t := range o.tools {
		own = append(own, Plugin{Name: t.definition.Name, Setup: func(r *Registrar) error { return r.Tool(t) }})
	}
	own = append(own, o.plugins...)
	for _, p := range own {
		if err := loadPlugin(h, p); err != nil {
			return nil, appError(err, InvalidComposition)
		}
	}
	if err := pluginrpc.Load(ctx, h, project, state, specs); err != nil {
		if ctx.Err() != nil {
			return nil, appError(ctx.Err(), CancelledCode)
		}
		return nil, &Error{Code: InvalidComposition, Message: err.Error()}
	}
	models := a.Models()
	if defaults.Model == "" && len(models) == 1 {
		defaults.Model = models[0].ModelRef.String()
	}
	if defaults.Model != "" {
		valid := false
		for _, m := range models {
			if m.ModelRef.String() == defaults.Model {
				valid = true
				break
			}
		}
		if !valid {
			return nil, &Error{Code: InvalidComposition, Message: fmt.Sprintf("model %q is not offered", defaults.Model)}
		}
	}
	success = true
	return a, nil
}

func (a *Agent) Close(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	a.closeOnce.Do(func() {
		a.lifecycle.Lock()
		a.closed.Store(true)
		a.lifecycle.Unlock()
		a.closeErr = a.h.Close()
		if a.scratch != "" {
			if err := os.RemoveAll(a.scratch); a.closeErr == nil {
				a.closeErr = err
			}
		}
	})
	return appError(a.closeErr, Lost)
}
func (a *Agent) Session(ctx context.Context) (*Session, error) {
	a.lifecycle.Lock()
	defer a.lifecycle.Unlock()
	if a.closed.Load() {
		return nil, &Error{Code: NotOpen, Message: "agent is closed"}
	}
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	id, err := a.a.New(ctx, a.project)
	if err != nil {
		return nil, appError(err, Lost)
	}
	return &Session{agent: a, id: id}, nil
}
func (a *Agent) OpenSession(ctx context.Context, id string) (*Session, error) {
	a.lifecycle.Lock()
	if a.closed.Load() {
		a.lifecycle.Unlock()
		return nil, &Error{Code: NotOpen, Message: "agent is closed"}
	}
	ctx = api.AsActor(ctx, localActor)
	if err := ctx.Err(); err != nil {
		a.lifecycle.Unlock()
		return nil, appError(err, CancelledCode)
	}
	if id == "" {
		a.lifecycle.Unlock()
		return nil, &Error{Code: InvalidParams, Message: "session id is empty"}
	}
	if _, err := a.a.Snapshot(id); err == nil {
		a.lifecycle.Unlock()
		return nil, &Error{Code: Busy, Message: "session is already open"}
	}
	err := a.a.Open(ctx, id)
	a.lifecycle.Unlock()
	if err != nil {
		return nil, appError(err, Busy)
	}
	if _, err := a.a.Wait(ctx, id); err != nil {
		_ = a.a.StopSession(id)
		return nil, appError(err, Lost)
	}
	return &Session{agent: a, id: id}, nil
}
func (a *Agent) Declaration() Declaration {
	d := acpinterface.Declaration(a.a, a.project, "")
	d["nestedToolCalls"] = false
	d["portableSessions"] = a.persistent
	d["queuedInputAfterRestart"] = "handedBack"
	d["questionsOutlastTurns"], d["lateAnswersStartTurns"] = false, false
	d["startsTurnsUnasked"] = "never"
	d["severalActors"], d["sessionLimits"], d["tenants"] = false, false, false
	d["erasure"] = a.persistent
	d["confinesFiles"] = false
	if v, err := a.a.Get("working-environment"); err == nil {
		if e, ok := v.(interface{ ConfinesFiles() bool }); ok {
			d["confinesFiles"] = e.ConfinesFiles()
		}
	}
	for _, p := range a.a.All("provider.") {
		for _, m := range p.(api.Provider).Catalog() {
			if m.Stateful {
				d["keepsStateAtProvider"] = true
			}
			if m.RunsTools {
				d["runsToolsAtProvider"] = true
			}
		}
	}
	return d
}

func (a *Agent) ServeACP(ctx context.Context) error { return a.serveACP(ctx, os.Stdin, os.Stdout) }

func (a *Agent) serveACP(ctx context.Context, in io.ReadCloser, out io.Writer) error {
	if !a.pluginHost {
		return &Error{Code: InvalidComposition, Message: "ACP requires WithPluginHost(true)"}
	}
	v, err := a.a.Get("interface.acp")
	if err != nil {
		return appError(err, NotSupported)
	}
	return appError(v.(*acpinterface.Interface).Serve(ctx, in, out), Lost)
}

func decodeInto(v any, p any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, p)
}
func validApproval(a string) bool { return a == "off" || a == "ask" || a == "all" || a == "never" }
func applySetting(s *api.Settings, k string, v any) error {
	bad := &Error{Code: InvalidParams, Message: "invalid setting: " + k}
	switch k {
	case "model":
		if name, ok := v.(string); ok && name != "" {
			s.Model = name
			return nil
		}
		var ref ModelRef
		if decodeInto(v, &ref) == nil && ref.Provider != "" && ref.ID != "" {
			s.Model = ref.String()
			return nil
		}
	case "reasoning":
		if val, ok := v.(string); ok {
			s.Thinking = val
			return nil
		}
	case "approval":
		if val, ok := v.(string); ok && validApproval(val) {
			s.Approval = api.ApprovalInternal(val)
			return nil
		}
	case "maxSteps", "maxOutput", "go.contextLimit":
		var n int
		if v != nil && decodeInto(v, &n) == nil && n >= 0 {
			switch k {
			case "maxSteps":
				s.MaxSteps = n
			case "maxOutput":
				s.MaxOutput = n
			default:
				s.ContextLimit = n
			}
			return nil
		}
	}
	return bad
}
