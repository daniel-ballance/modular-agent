// Package vanilla is the composition root. Every behavior is installed as a plugin.
package vanilla

import (
	"encoding/json"
	"fmt"
	"modular/acpinterface"
	"modular/anthropic"
	"modular/api"
	"modular/approval"
	"modular/commands"
	"modular/configuration"
	"modular/contextview"
	"modular/guardrail"
	"modular/harness"
	"modular/history"
	"modular/jobs"
	"modular/local"
	"modular/mcptools"
	"modular/modelselect"
	"modular/pluginrpc"
	"modular/questions"
	"modular/subagents"
	"modular/systemprompt"
	"modular/terminal"
	"modular/tools"
	"modular/transient"
	"os"
	"path/filepath"
)

type Options struct {
	History, Global, Model string
	DataDir                string
	Store, Environment     api.Plugin
	Provider               api.Plugin
	Runtime                api.Plugin
	DurableSubagents       bool
	MaxSubagentDepth       int
	Secrets                []string
	Project                string
	TrustProject           bool
	Factories              map[string]configuration.Factory
}

func New(opt Options) (*harness.Harness, error) {
	h := harness.New()
	provider := opt.Provider
	if provider.Name == "" && os.Getenv("MODULAR_AGENT_PLUGINS") == "" {
		return nil, fmt.Errorf("model gateway Provider required (or use the offline fake Provider)")
	}
	if opt.Model == "" {
		opt.Model = anthropic.ModelID
	}
	runtime := opt.Runtime
	if runtime.Name == "" {
		runtime = transient.Plugin()
	}
	store, environment := opt.Store, opt.Environment
	if store.Name == "" {
		store = history.Plugin(opt.History)
	}
	if environment.Name == "" {
		environment = local.PluginAt(filepath.Join(opt.History, "commands"), opt.History)
	}
	plugins := []api.Plugin{
		store,
		configuration.PluginAt(opt.Global, api.Settings{Model: opt.Model, Thinking: "off", MaxSteps: 12, MaxOutput: 1024}, opt.DataDir),
		provider, modelselect.Plugin(),
		environment, tools.Plugin(), runtime, contextview.Plugin(), systemprompt.Plugin(),
		commands.Plugin(), questions.Plugin(), approval.Plugin(), jobs.Plugin(), subagents.Plugin(opt.DurableSubagents, opt.MaxSubagentDepth), guardrail.Plugin(opt.Secrets), mcptools.Plugin(nil, opt.Project), terminal.Plugin(), acpinterface.Plugin(opt.Project),
	}
	for _, plugin := range plugins {
		if plugin.Name == "" {
			continue
		}
		if err := h.Load(plugin); err != nil {
			_ = h.Close()
			return nil, err
		}
	}
	if opt.Project != "" {
		project, err := configuration.Canonical(opt.Project)
		if err != nil {
			_ = h.Close()
			return nil, err
		}
		if err = h.Load(configuration.BoundProject(project)); err != nil {
			_ = h.Close()
			return nil, err
		}
	}
	specs, err := configuration.Plugins(opt.Global, configuration.StateProject(opt.DataDir, opt.Project), opt.TrustProject)
	if err != nil {
		_ = h.Close()
		return nil, err
	}
	factories := map[string]configuration.Factory{
		"mcp": func(b json.RawMessage) (api.Plugin, error) {
			var opts struct {
				Servers []mcptools.Server `json:"servers"`
			}
			if err := json.Unmarshal(b, &opts); err != nil {
				return api.Plugin{}, err
			}
			p := mcptools.Plugin(opts.Servers, opt.Project)
			p.Name = "configured-mcp"
			p.Replaces = "mcp"
			return p, nil
		},
		"guardrail": func(b json.RawMessage) (api.Plugin, error) {
			var opts struct {
				Secrets []string `json:"secrets"`
			}
			if err := json.Unmarshal(b, &opts); err != nil {
				return api.Plugin{}, err
			}
			p := guardrail.Plugin(opts.Secrets)
			p.Name = "configured-guardrail"
			p.Replaces = "guardrail"
			return p, nil
		},
	}
	for name, factory := range opt.Factories {
		factories[name] = factory
	}
	for _, spec := range specs {
		factory, ok := factories[spec.Name]
		if !ok {
			_ = h.Close()
			return nil, fmt.Errorf("unknown configured plugin %q", spec.Name)
		}
		p, err := factory(api.JSON(spec.Options))
		if err == nil {
			err = h.Load(p)
		}
		if err != nil {
			_ = h.Close()
			return nil, fmt.Errorf("configured plugin %q: %w", spec.Name, err)
		}
	}
	project := opt.Project
	if project == "" {
		project, err = os.Getwd()
		if err != nil {
			_ = h.Close()
			return nil, err
		}
	}
	pluginHome := opt.DataDir
	if pluginHome == "" {
		pluginHome = filepath.Dir(opt.History)
	}
	if err := pluginrpc.LoadEnvironment(h, project, pluginHome); err != nil {
		_ = h.Close()
		return nil, err
	}
	if len(h.API().All("provider.")) == 0 {
		_ = h.Close()
		return nil, fmt.Errorf("no Provider registered")
	}
	return h, nil
}
