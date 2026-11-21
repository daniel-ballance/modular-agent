package modular

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type wirePlugin struct {
	plugin Plugin
	config map[string]any
}

// WithWirePlugin loads a plugin through the actual plugin binding over an in-memory pipe.
func WithWirePlugin(plugin Plugin) Option {
	return func(o *options) error { o.wire = append(o.wire, wirePlugin{plugin, plugin.Config}); return nil }
}

// Serve runs the stdio plugin binding until the streams disconnect.
func Serve(ctx context.Context, plugin Plugin) error {
	err := serve(ctx, plugin, os.Stdin, os.Stdout)
	if ctx.Err() != nil {
		return appError(ctx.Err(), CancelledCode)
	}
	return err
}

// TLSOptions names a PEM certificate and private key for a WebSocket service.
type TLSOptions = wswire.TLSOptions

// Service is a listening WebSocket server. Close stops accepting and waits
// for the connection instances to stop. URL includes the bound port.
type Service = wswire.Server

type ServeOptions struct {
	Listen, TokenFile string
	TLS               *TLSOptions
}

// ServeService listens for plugin connections. Setup runs separately for every
// initialization; connection-local state belongs inside Setup, not its closure.
func ServeService(ctx context.Context, plugin Plugin, options ServeOptions) (*Service, error) {
	return ServeServiceFactory(ctx, func() Plugin { return plugin }, options)
}

// ServeServiceFactory also gives the plugin's Setup and Stop closures their
// own instance, for plugins that share state between those two functions.
func ServeServiceFactory(ctx context.Context, factory func() Plugin, options ServeOptions) (*Service, error) {
	if factory == nil {
		return nil, &Error{Code: InvalidParams, Message: "plugin factory required"}
	}
	token, err := wswire.ReadToken(options.TokenFile)
	if err != nil {
		return nil, appError(err, InvalidParams)
	}
	service, err := wswire.Listen(ctx, options.Listen, options.TLS, wswire.Plugin, map[string]struct{}{token: {}}, func(ctx context.Context, conn *wswire.Conn, _ struct{}) {
		_ = servePlugin(factory(), func(s *pluginrpc.Server) error { return s.ServeServiceConnection(ctx, conn) })
	})
	return service, appError(err, InvalidParams)
}

func serve(ctx context.Context, plugin Plugin, in io.ReadCloser, out io.Writer) error {
	return servePlugin(plugin, func(s *pluginrpc.Server) error { return s.Serve(ctx, in, out) })
}

func servePlugin(plugin Plugin, run func(*pluginrpc.Server) error) error {
	if plugin.Name == "" {
		return &Error{Code: InvalidComposition, Message: "plugin name is empty"}
	}
	var startup sync.Mutex
	var initialized, closed bool
	var startupErr error
	server := &pluginrpc.Server{}
	var unsub []func()
	defer func() {
		for _, f := range unsub {
			f()
		}
	}()
	server.Initialize = func(init pluginrpc.Object) error {
		startup.Lock()
		defer startup.Unlock()
		if closed {
			return serveFault(&Error{Code: Lost, Message: "plugin connection closed"})
		}
		if startupErr != nil {
			return serveFault(startupErr)
		}
		config := map[string]any{}
		if init["config"] != nil {
			if err := decodeInto(init["config"], &config); err != nil {
				return serveFault(appError(err, InvalidRequest))
			}
		}
		initialized = true
		r, err := register(plugin, config)
		if err == nil {
			err = canServe(r)
		}
		if err != nil {
			startupErr = appError(err, InvalidRequest)
			return serveFault(startupErr)
		}
		reg := pluginrpc.Registration{Binding: pluginrpc.Binding, Name: plugin.Name, Replaces: plugin.Replaces}
		var owner *jobAdapter
		if r.jobOwner != nil {
			owner = &jobAdapter{name: plugin.Name, owner: *r.jobOwner, server: server}
			server.JobCancel = owner.cancel
		}
		if r.runtime != nil {
			d := r.runtime.Declaration()
			reg.Runtime = &pluginrpc.RuntimeRegistration{ID: plugin.Name, Supports: pluginrpc.RuntimeSupports{
				InputDuringTurn: d.Steering, WaitingThroughRestart: d.WaitingThroughRestart, ContinuesAfterRestart: d.Durable,
			}}
			server.Runtime = r.runtime
		}
		if r.environment != nil {
			reg.Environment = environmentRegistration(r.environment)
			server.Environment = r.environment
		}
		if len(r.tools) > 0 {
			source := &toolSource{tools: r.tools, server: server, plugin: plugin.Name, jobs: owner}
			sr := pluginrpc.SourceRegistration{ID: "tools"}
			for _, t := range source.Tools(api.Session{}) {
				sr.Tools = append(sr.Tools, portable.Tool(t))
			}
			reg.ToolSources = []pluginrpc.SourceRegistration{sr}
			server.Sources = map[string]api.ToolSource{sr.ID: source}
		}
		for _, source := range r.sources {
			adapter := &toolSource{dynamic: source.Tools, server: server, plugin: plugin.Name, jobs: owner}
			sr := pluginrpc.SourceRegistration{ID: source.ID, PerSession: source.PerSession}
			for _, t := range adapter.Tools(api.Session{}) {
				sr.Tools = append(sr.Tools, portable.Tool(t))
			}
			reg.ToolSources = append(reg.ToolSources, sr)
			if server.Sources == nil {
				server.Sources = map[string]api.ToolSource{}
			}
			server.Sources[sr.ID] = adapter
			unsub = append(unsub, bindToolChanges(server, source))
		}
		server.Providers = map[string]api.Provider{}
		for _, p := range r.providers {
			provider := providerAdapter{p: p, read: server.ProviderCredential}
			pr := pluginrpc.ProviderRegistration{ID: p.ID}
			pr.Supports.KeepsState = p.Supports.KeepsState
			for _, model := range provider.Catalog() {
				pr.Models = append(pr.Models, portable.Model(model))
			}
			reg.Providers = append(reg.Providers, pr)
			server.Providers[p.ID] = provider
		}
		server.Handlers = map[int]func(context.Context, string, pluginrpc.Object) (any, error){}
		for i, hook := range r.hooks {
			id := i + 1
			reg.Hooks = append(reg.Hooks, pluginrpc.HookRegistration{Hook: hook.point, ID: id, Order: string(hook.order)})
			server.Handlers[id] = func(ctx context.Context, point string, p pluginrpc.Object) (any, error) {
				if point != hook.point {
					return nil, serveFault(&Error{Code: UnknownHandler, Message: "unknown handler"})
				}
				answer, err := withHookContext(ctx, nil, server, plugin.Name, p, hook.handle)
				if x, ok := answer.(pluginrpc.Object); ok && (x["pending"] != nil || x["command"] != nil) {
					return nil, serveFault(&Error{Code: NotSupported, Message: "hook answer is in-process only"})
				}
				return answer, serveFault(err)
			}
		}
		if owner != nil && owner.owner.Resume != nil {
			id := len(r.hooks) + 1
			reg.Hooks = append(reg.Hooks, pluginrpc.HookRegistration{Hook: "session.start", ID: id, Order: "first"})
			server.Handlers[id] = func(ctx context.Context, point string, p pluginrpc.Object) (any, error) {
				if point != "session.start" {
					return nil, serveFault(&Error{Code: UnknownHandler, Message: "unknown handler"})
				}
				if p["resumed"] != true {
					return nil, nil
				}
				session, _ := p["sessionId"].(string)
				return nil, serveFault(owner.resume(ctx, session))
			}
		}
		server.Commands = map[string]func(context.Context, pluginrpc.Object) (any, error){}
		for _, c := range r.commands {
			reg.Commands = append(reg.Commands, pluginrpc.CommandRegistration{Name: c.Name, Description: c.Description})
			server.Commands[c.Name] = func(ctx context.Context, p pluginrpc.Object) (any, error) {
				str := func(key string) string { v, _ := p[key].(string); return v }
				args, ok := p["args"].(string)
				if !ok {
					var legacy []string
					if err := decodeInto(p["args"], &legacy); err != nil {
						return nil, serveFault(&Error{Code: InvalidRequest, Message: "command args must be text"})
					}
					args = strings.Join(legacy, " ")
				}
				text, err := runSDKCommand(ctx, nil, server, plugin.Name, str("sessionId"), str("actorId"), c, args, owner)
				return pluginrpc.Object{"output": text}, serveFault(err)
			}
		}
		server.Registration = reg
		return nil
	}
	err := run(server)
	startup.Lock()
	closed = true
	startup.Unlock()
	if initialized && plugin.Stop != nil {
		err = errors.Join(err, plugin.Stop())
	}
	if startupErr != nil {
		return startupErr
	}
	return appError(err, Lost)
}
func canServe(r *Registrar) error {
	for name := range r.defined {
		return &Error{Code: NotSupported, Message: "in-process-only hook " + name}
	}
	for _, part := range []struct {
		name  string
		local bool
	}{{"history", r.history.make != nil}, {"credential store", r.credentials != nil}, {"configuration", r.configuration != nil}, {"Interface", r.front != nil}} {
		if part.local {
			return &Error{Code: NotSupported, Message: "in-process-only " + part.name}
		}
	}
	for _, source := range r.sources {
		for _, tool := range source.Tools("") {
			if tool.only {
				return &Error{Code: NotSupported, Message: "in-process-only tool " + tool.definition.Name}
			}
		}
	}
	for _, t := range r.tools {
		if t.only {
			return &Error{Code: NotSupported, Message: "in-process-only tool " + t.definition.Name}
		}
	}
	for _, h := range r.hooks {
		if h.only {
			return &Error{Code: NotSupported, Message: "in-process-only hook " + h.point}
		}
	}
	for _, c := range r.commands {
		if c.InProcessOnly || c.UsesModel {
			return &Error{Code: NotSupported, Message: "in-process-only command " + c.Name}
		}
	}
	return nil
}
func serveFault(err error) error {
	if err == nil {
		return nil
	}
	e := appError(err, Internal).(*Error)
	fault := &pluginrpc.RPCError{Message: e.Message}
	fault.Data.Code = string(e.Code)
	fault.Data.Limit, _ = e.Data["limit"].(string)
	return fault
}
