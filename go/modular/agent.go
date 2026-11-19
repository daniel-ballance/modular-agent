// Package modular builds agents without exposing the underlying Harness.
package modular

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"

	"github.com/OWNER/modular-agent/go/acpinterface"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/approval"
	"github.com/OWNER/modular-agent/go/commands"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/conformancemodel"
	"github.com/OWNER/modular-agent/go/contextview"
	"github.com/OWNER/modular-agent/go/durable"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/jobs"
	"github.com/OWNER/modular-agent/go/local"
	"github.com/OWNER/modular-agent/go/mcptools"
	"github.com/OWNER/modular-agent/go/modelselect"
	"github.com/OWNER/modular-agent/go/pluginrpc"
	"github.com/OWNER/modular-agent/go/portable"
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
	wire                    []wirePlugin
	environment             Environment
	host                    *bool
	settings                Settings
	approval                Approval
	handler                 QuestionHandler
	history                 HistoryStore
	mcp                     []MCPServer
	mcpWarning              func(error)
	conformance             bool
	input                   func(context.Context, Content) (Content, error)
}
type Environment = api.WorkingEnvironment
type DirEntry = api.DirEntry
type ExecResult = api.ExecResult

func WithEnvironment(env Environment) Option {
	return func(o *options) error { o.environment = env; return nil }
}

type Option func(*options) error

func WithProject(p string) Option { return func(o *options) error { o.project = p; return nil } }
func WithDataDir(p string) Option { return func(o *options) error { o.dataDir = p; return nil } }

// WithModel accepts a shared ModelRef or a "provider/id" string.
func WithModel(model any) Option {
	return func(o *options) error {
		var ref api.Settings
		if err := applySetting(&ref, "model", model); err != nil {
			return err
		}
		o.model = ref.Model
		return nil
	}
}
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
	erasure    bool
	closed     atomic.Bool
	restarting atomic.Bool
	lifecycle  sync.Mutex
	settingsMu sync.Mutex
	pluginHost bool
	q          *questionRouter
	closeOnce  sync.Once
	closeErr   error
	restart    func(context.Context) (*Agent, error)
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
	if o.host != nil && !*o.host && len(o.process) > 0 {
		return nil, &Error{Code: InvalidComposition, Message: "process plugins require a plugin host"}
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
	// The default ephemeral environment can discard its scratch bookkeeping.
	// Nothing that promises recovery may keep that bookkeeping in scratch.
	if o.dataDir == "" {
		bookkeeping, _ := o.environment.(interface{ NeedsDataDir() bool })
		if (o.environment == nil && o.durability != Ephemeral) || (bookkeeping != nil && bookkeeping.NeedsDataDir()) {
			return nil, &Error{Code: InvalidComposition, Message: "working environment recovery bookkeeping requires dataDir"}
		}
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
	if o.conformance {
		defaults.Model, defaults.Approval = conformancemodel.ID, "off"
	}
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
	for _, w := range o.wire {
		specs = append(specs, pluginrpc.Spec{Config: w.config, Serve: func(ctx context.Context, in io.ReadCloser, out io.Writer) error { return serve(ctx, w.plugin, in, out) }})
	}
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
	a := &Agent{h: h, a: h.API(), project: project, pluginHost: host, persistent: o.durability != Ephemeral, erasure: o.history.make == nil || o.history.erasure}
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
	var environment api.Plugin
	if o.environment == nil {
		environment = local.PluginAt(filepath.Join(state, "commands"), state)
	} else {
		environment = api.Plugin{Name: "environment", Setup: func(a api.API) error { return a.Provide("working-environment", o.environment) }, Close: o.environment.Close}
	}
	core := []api.Plugin{historyPlugin,
		{Name: "configuration", Setup: func(a api.API) error { return a.Provide("configuration", sessionDefaults{&defaults}) }},
		{Name: "sdk-credentials", Setup: func(a api.API) error { return a.Provide("credentials", environmentCredentials{}) }},
		configuration.BoundProject(project), environment, runtime,
		modelselect.Plugin(), contextview.Plugin(), questions.Plugin(), acpinterface.Plugin(project),
		mcptools.Configured(o.mcp, project, o.mcpWarning),
		{Name: "sdk-model-admission", Setup: func(host api.API) error {
			return host.Handle("input", "last", func(_ context.Context, payload any) (api.Decision, error) {
				input := payload.(api.InputEvent)
				snap, err := host.Snapshot(input.Session)
				if err != nil {
					return api.Decision{}, err
				}
				if model := snap.Settings.Model; model != "" && !a.offersModel(model) {
					return api.Decision{}, fmt.Errorf("%w: %q", api.ErrUnknownModel, model)
				}
				return api.Decision{}, nil
			})
		}}}
	if o.approval != "" || o.conformance {
		core = append(core, approval.Plugin())
	}
	if o.conformance {
		core = append(core, conformancemodel.Plugin(), pluginrpc.NestFixture(), jobs.Plugin())
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
		if stop := p.Stop; stop != nil {
			p.Stop = func() error {
				if a.restarting.Load() {
					return nil
				}
				return stop()
			}
		}
		if err := loadPlugin(h, p); err != nil {
			var e *Error
			if errors.As(err, &e) && e.Code == NotSupported {
				return nil, e
			}
			return nil, &Error{Code: InvalidComposition, Message: err.Error()}
		}
	}
	if o.input != nil {
		if err := h.Load(api.Plugin{Name: "sdk-input", Setup: func(a api.API) error {
			return a.Handle("input", "first", func(ctx context.Context, payload any) (api.Decision, error) {
				in := payload.(api.InputEvent)
				var content Content
				if err := decodeInto(portable.Content(in.Input.Content), &content); err != nil {
					return api.Decision{}, err
				}
				out, err := o.input(ctx, content)
				if err != nil {
					return api.Decision{}, err
				}
				in.Input.Content = portable.ReadContent(out)
				return api.Decision{Value: in}, nil
			})
		}}); err != nil {
			return nil, appError(err, InvalidComposition)
		}
	}
	if err := h.Load(commands.Plugin()); err != nil {
		return nil, appError(err, InvalidComposition)
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
	if defaults.Model != "" && !a.offersModel(defaults.Model) {
		return nil, &Error{Code: InvalidRequest, Message: fmt.Sprintf("model %q is not offered", defaults.Model)}
	}
	if len(specs) == 0 {
		options := append([]Option{}, opts...)
		if memory, ok := hs.(*memoryStore); ok {
			options = append(options, WithHistory(memoryHistory(memory)))
		}
		a.restart = func(ctx context.Context) (*Agent, error) { return New(ctx, options...) }
	}
	success = true
	return a, nil
}

func (a *Agent) offersModel(ref string) bool {
	return slices.ContainsFunc(a.Models(), func(m ModelInfo) bool { return m.ModelRef.String() == ref })
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
	d["portableSessions"] = a.persistent
	inputs, reports := a.h.QueuedRecoveryPolicy()
	d["queuedInputAfterRestart"] = inputs
	if reports != inputs {
		d["queuedJobReportsAfterRestart"] = reports
	}
	if settings, ok := a.a.(interface{ SettingsDuringTurn() string }); ok {
		d["settingsDuringTurn"] = settings.SettingsDuringTurn()
	} else {
		d["settingsDuringTurn"] = "refused"
	}
	runtime, err := a.a.Get("runtime")
	d["nestedToolCalls"] = err == nil && runtime.(api.Runtime).Declaration().NestedToolCalls
	d["questionsOutlastTurns"], d["lateAnswersStartTurns"] = false, false
	d["startsTurnsUnasked"] = "never"
	d["severalActors"], d["sessionLimits"], d["tenants"] = false, false, false
	d["erasure"] = a.erasure
	d["confinesFiles"], d["commandContainment"] = false, "none"
	if v, err := a.a.Get("working-environment"); err == nil {
		if e, ok := v.(interface{ Containment() string }); ok {
			d["commandContainment"] = e.Containment()
		}
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

func (a *Agent) ServeACP(ctx context.Context) error {
	return a.ServeACPStreams(ctx, os.Stdin, os.Stdout)
}

// ServeACPStreams serves ACP on the supplied streams until the connection ends.
func (a *Agent) ServeACPStreams(ctx context.Context, in io.ReadCloser, out io.Writer) error {
	return a.serveACP(ctx, in, out)
}

func (a *Agent) serveACP(ctx context.Context, in io.ReadCloser, out io.Writer) error {
	if !a.pluginHost {
		return &Error{Code: InvalidComposition, Message: "ACP requires WithPluginHost(true)"}
	}
	v, err := a.a.Get("interface.acp")
	if err != nil {
		return appError(err, NotSupported)
	}
	return appError(v.(*acpinterface.Interface).ServeWithDeclaration(ctx, in, out, func() map[string]any { return a.Declaration() }), Lost)
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
	case "modelTools":
		if v == nil {
			s.ModelTools = nil
			return nil
		}
		var names []string
		if decodeInto(v, &names) == nil {
			if names == nil {
				s.ModelTools = nil
			} else {
				s.ModelTools = &names
			}
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
