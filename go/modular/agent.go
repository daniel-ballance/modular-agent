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
	"time"

	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/approval"
	"github.com/daniel-ballance/modular-agent/go/commands"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/contextview"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/jobs"
	"github.com/daniel-ballance/modular-agent/go/local"
	"github.com/daniel-ballance/modular-agent/go/mcptools"
	"github.com/daniel-ballance/modular-agent/go/modelselect"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/questions"
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

// ServicePlugin loads a trusted plugin over a WebSocket.
type ServicePlugin struct {
	URL, TokenFile string
	Config         map[string]any
	// Zero selects the defaults (30 seconds of silence and a 5 second control wait).
	PingInterval, ControlDeadline time.Duration
}

type options struct {
	project, dataDir, model                 string
	durability                              Durability
	providers                               []Provider
	plugins                                 []Plugin
	tools                                   []Tool
	process                                 []ProcessPlugin
	services                                []ServicePlugin
	wire                                    []wirePlugin
	environment                             Environment
	runtime                                 Runtime
	credentials                             CredentialStore
	severalActors, sessionLimits            bool
	tenants                                 map[string]Tenant
	host                                    *bool
	settings                                Settings
	approval                                Approval
	handler                                 QuestionHandler
	history                                 HistoryStore
	mcp                                     []MCPServer
	mcpWarning                              func(error)
	conformance                             bool
	jobReports, lateAnswers, refuseSettings bool
	compaction                              bool
	input                                   func(context.Context, Content) (Content, error)
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
func WithProcessPlugin(p ProcessPlugin) Option { return WithProcessPlugins(p) }

// WithProcessPlugins appends process plugins in load order.
func WithProcessPlugins(plugins ...ProcessPlugin) Option {
	plugins = slices.Clone(plugins)
	return func(o *options) error { o.process = append(o.process, plugins...); return nil }
}

func WithServicePlugin(p ServicePlugin) Option { return WithServicePlugins(p) }

// WithServicePlugins appends service plugins in load order.
func WithServicePlugins(plugins ...ServicePlugin) Option {
	plugins = slices.Clone(plugins)
	return func(o *options) error { o.services = append(o.services, plugins...); return nil }
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
func WithOnQuestion(h QuestionHandler) Option {
	return func(o *options) error { o.handler = h; return nil }
}

// WithCompaction controls automatic summarization and the /compact command.
// Compaction is enabled by default.
func WithCompaction(enabled bool) Option {
	return func(o *options) error { o.compaction = enabled; return nil }
}

// WithJobReportsStartTurns lets a job's report start a turn without new actor input.
func WithJobReportsStartTurns(enabled bool) Option {
	return func(o *options) error { o.jobReports = enabled; return nil }
}

// WithLateAnswersStartTurns lets a question stay open and its answer continue the call.
func WithLateAnswersStartTurns(enabled bool) Option {
	return func(o *options) error { o.lateAnswers = enabled; return nil }
}

// WithRefusedSettingsDuringTurn refuses settings changes while a turn is active.
func WithRefusedSettingsDuringTurn() Option {
	return func(o *options) error { o.refuseSettings = true; return nil }
}

type Agent struct {
	h                                     *harness.Harness
	a                                     api.API
	project                               string
	scratch                               string
	persistent                            bool
	jobReports, lateAnswers               bool
	erasure                               bool
	closed                                atomic.Bool
	restarting                            atomic.Bool
	lifecycle                             sync.Mutex
	settingsMu                            sync.Mutex
	pluginHost                            bool
	q                                     *questionRouter
	severalActors, sessionLimits, tenants bool
	defaults                              api.Settings
	closeOnce                             sync.Once
	closeErr                              error
	restart                               func(context.Context) (*Agent, error)
}
type sessionDefaults struct{ settings *api.Settings }

func (s sessionDefaults) Settings(string) (api.Settings, error) { return *s.settings, nil }

func New(ctx context.Context, opts ...Option) (*Agent, error) {
	o := options{durability: Ephemeral, settings: Settings{}, compaction: true}
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
	if o.host != nil && !*o.host && (len(o.process) > 0 || len(o.services) > 0) {
		return nil, &Error{Code: InvalidComposition, Message: "process and service plugins require a plugin host"}
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
	host := len(o.process) > 0 || len(o.services) > 0
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
	for _, p := range o.services {
		if p.URL == "" {
			return nil, &Error{Code: InvalidComposition, Message: "plugin service URL is empty"}
		}
		specs = append(specs, pluginrpc.Spec{URL: p.URL, TokenFile: p.TokenFile, Config: p.Config, PingInterval: p.PingInterval, ControlDeadline: p.ControlDeadline})
	}
	if host {
		more, e := pluginrpc.EnvironmentSpecs()
		if e != nil {
			return nil, appError(e, InvalidComposition)
		}
		specs = append(specs, more...)
	}
	h := harness.NewWithLocalActor(localActor)
	h.ConfigureTenants(o.tenants)
	h.HandBackQueuedOnOpen()
	h.ConfigureSessions(o.jobReports, o.lateAnswers, o.refuseSettings)
	a := &Agent{severalActors: o.severalActors, sessionLimits: o.sessionLimits, tenants: o.tenants != nil, jobReports: o.jobReports, lateAnswers: o.lateAnswers, h: h, a: h.API(), project: project, pluginHost: host, persistent: o.durability != Ephemeral, erasure: o.history.make == nil || o.history.erasure}
	state := o.dataDir
	if state == "" || (o.durability == Ephemeral && o.environment == nil) {
		a.scratch, err = os.MkdirTemp("", "modular-go-")
		if err != nil {
			return nil, appError(err, InvalidComposition)
		}
		if state == "" {
			state = a.scratch
		}
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
	runtime := o.runtime
	if runtime == nil {
		runtime = TransientRuntime()
		if o.durability == Durable {
			runtime = DurableRuntime()
		}
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
		environmentState := state
		if o.durability == Ephemeral {
			environmentState = a.scratch
		}
		environment = local.GitPluginAt(filepath.Join(environmentState, "commands"), environmentState)
	} else {
		environment = api.Plugin{Name: "environment", Setup: func(a api.API) error { return a.Provide("working-environment", o.environment) }, Close: o.environment.Close}
	}
	if o.credentials == nil {
		o.credentials = EnvironmentCredentials()
	}
	core := []api.Plugin{historyPlugin,
		{Name: "configuration", Setup: func(a api.API) error { return a.Provide("configuration", sessionDefaults{&defaults}) }},
		{Name: "sdk-credentials", Setup: func(a api.API) error { return a.Provide("credentials", o.credentials) }},
		configuration.BoundProject(project), environment,
		{Name: "sdk-runtime", Setup: func(host api.API) error { return runtimeSetup(host, runtime) }},
		modelselect.Plugin(), contextview.PluginWithCompaction(o.compaction), questions.Plugin(), jobs.Plugin(), acpinterface.Plugin(project),
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
		core = append(core, conformancemodel.Plugin(), pluginrpc.NestFixture())
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
	if len(specs) == 0 {
		if err := pluginrpc.WrapLocalProviders(h); err != nil {
			return nil, appError(err, InvalidComposition)
		}
	}
	if err := pluginrpc.Load(ctx, h, project, state, specs); err != nil {
		if ctx.Err() != nil {
			return nil, appError(ctx.Err(), CancelledCode)
		}
		return nil, &Error{Code: InvalidComposition, Message: err.Error()}
	}
	selectedRuntime, err := a.a.Get("runtime")
	if err != nil {
		return nil, appError(err, InvalidComposition)
	}
	continues := selectedRuntime.(Runtime).Declaration().Durable
	// The conformance harness deliberately probes a non-recovering served
	// Runtime on a durable host. Ordinary SDK compositions must agree.
	if continues && o.durability != Durable || !o.conformance && !continues && o.durability == Durable {
		return nil, &Error{Code: InvalidComposition, Message: "selected Runtime does not match the durability mode"}
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
	a.defaults = defaults
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
func (a *Agent) Session(ctx context.Context, options ...SessionOptions) (*Session, error) {
	a.lifecycle.Lock()
	defer a.lifecycle.Unlock()
	if a.closed.Load() {
		return nil, &Error{Code: NotOpen, Message: "agent is closed"}
	}
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if len(options) > 1 {
		return nil, &Error{Code: InvalidParams, Message: "at most one SessionOptions value"}
	}
	var opt SessionOptions
	if len(options) > 0 {
		opt = options[0]
	}
	if (opt.Tenant != "" && !a.tenants) || (len(opt.Actors) > 0 && !a.severalActors) {
		return nil, &Error{Code: NotSupported, Message: "session feature disabled"}
	}
	settings := a.defaults
	for key, value := range opt.Settings {
		if err := applySetting(&settings, key, value); err != nil {
			return nil, err
		}
	}
	if settings.Model != "" && !a.offersModel(settings.Model) {
		return nil, &Error{Code: InvalidRequest, Message: "model is not offered"}
	}
	var initial []api.Actor
	seen := make(map[string]bool)
	for _, actor := range opt.Actors {
		if err := validActor(actor); err != nil {
			return nil, err
		}
		if seen[actor.ID] {
			return nil, &Error{Code: InvalidParams, Message: "duplicate initial actor"}
		}
		seen[actor.ID] = true
		if actor.ID == localActor && !slices.Contains(actor.Rights, "input") {
			return nil, &Error{Code: Forbidden, Message: "the local actor requires input to create a session"}
		}
		initial = append(initial, copyActor(actor))
	}
	ctx = api.WithSessionSettings(api.AsActor(ctx, localActor), settings)
	id, err := a.a.(interface {
		NewEmbedded(context.Context, string, string, []api.Actor) (string, error)
	}).NewEmbedded(ctx, a.project, opt.Tenant, initial)
	if errors.Is(err, api.ErrTenantForbidden) || errors.Is(err, api.ErrAuthority) {
		return nil, appError(err, Forbidden)
	}
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
	delete(d, "projectRoot")
	d["portableSessions"] = a.persistent
	inputs, reports := a.h.QueuedRecoveryPolicy()
	d["queuedInputAfterRestart"] = inputs
	delete(d, "queuedJobReportsAfterRestart")
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
	d["questionsOutlastTurns"], d["lateAnswersStartTurns"] = a.lateAnswers, a.lateAnswers
	d["startsTurnsUnasked"] = "never"
	if a.jobReports {
		d["startsTurnsUnasked"] = "jobReports"
	}
	d["severalActors"], d["sessionLimits"], d["tenants"] = a.severalActors, a.sessionLimits, a.tenants
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

// ServeACPOptions customizes project composition and session resources.
// A composed agent must use the connection's history store. The connection owns it.
type ServeACPOptions struct {
	Compose         func(context.Context, string) (*Agent, error)
	ProjectSettings func(project string) (Settings, error)
	ProjectMCP      func(project string) ([]MCPServer, error)
	WarnMCP         func(error)
	Input           io.ReadCloser
	Output          io.Writer
	Listen          string
	Actors          []ACPActor
	TLS             *TLSOptions
}

// ServeACP serves stdio (or the supplied streams), or blocks until its
// WebSocket listener and all connections have stopped.
func (a *Agent) ServeACP(ctx context.Context, options ...ServeACPOptions) error {
	if len(options) > 1 {
		return &Error{Code: InvalidParams, Message: "at most one ServeACPOptions value"}
	}
	var opt ServeACPOptions
	if len(options) == 1 {
		opt = options[0]
	}
	if opt.Listen != "" {
		service, err := a.ListenACP(ctx, opt)
		if err != nil {
			return err
		}
		<-service.Done()
		return service.Close()
	}
	if opt.TLS != nil || opt.Actors != nil {
		return &Error{Code: InvalidParams, Message: "ACP actors and TLS require Listen"}
	}
	if opt.Input == nil {
		opt.Input = os.Stdin
	}
	if opt.Output == nil {
		opt.Output = os.Stdout
	}
	iface, err := a.acpInterface()
	if err != nil {
		return err
	}
	declared, projects := a.acpResources(opt)
	return appError(iface.ServeWithDeclaration(ctx, opt.Input, opt.Output, declared, projects), Lost)
}

func (a *Agent) acpInterface() (*acpinterface.Interface, error) {
	if !a.pluginHost {
		return nil, &Error{Code: InvalidComposition, Message: "ACP requires WithPluginHost(true)"}
	}
	v, err := a.a.Get("interface.acp")
	if err != nil {
		return nil, appError(err, NotSupported)
	}
	return v.(*acpinterface.Interface), nil
}

func (a *Agent) acpResources(opt ServeACPOptions) (func() map[string]any, acpinterface.Projects) {
	declared := func() map[string]any {
		d := a.Declaration()
		if opt.Compose == nil {
			d["projectRoot"] = a.project
		}
		return d
	}
	projects := acpinterface.Projects{MCP: opt.ProjectMCP, WarnMCP: opt.WarnMCP}
	if opt.Compose != nil {
		projects.Compose = func(ctx context.Context, project, id string) (acpinterface.Project, error) {
			child, err := opt.Compose(context.WithValue(ctx, reopeningSessionKey{}, id), project)
			if err != nil {
				return acpinterface.Project{}, err
			}
			if child == nil || child == a || child.project != project {
				if child != nil && child != a {
					_ = child.Close(context.Background())
				}
				return acpinterface.Project{}, &Error{Code: InvalidComposition, Message: "Compose must return a separate agent bound to the requested project"}
			}
			return acpinterface.Project{API: child.a, Declaration: func() map[string]any { return child.Declaration() }, Close: func() error { return child.Close(context.Background()) }}, nil
		}
	}
	if opt.ProjectSettings != nil {
		projects.Settings = func(project string, defaults api.Settings) (api.Settings, error) {
			settings, err := opt.ProjectSettings(project)
			if err != nil {
				return defaults, err
			}
			for key, value := range settings {
				if err := applySetting(&defaults, key, value); err != nil {
					return defaults, err
				}
			}
			return defaults, nil
		}
	}
	return declared, projects
}

type reopeningSessionKey struct{}

// ACPReopeningSession returns the stored session ID when a factory is called for a reopen.
// The call does not grant access to the session or start its recovery.
func ACPReopeningSession(ctx context.Context) string {
	id, _ := ctx.Value(reopeningSessionKey{}).(string)
	return id
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
