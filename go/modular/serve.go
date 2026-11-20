package modular

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
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

func Serve(ctx context.Context, plugin Plugin) error {
	return serve(ctx, plugin, os.Stdin, os.Stdout)
}
func serve(ctx context.Context, plugin Plugin, in io.ReadCloser, out io.Writer) error {
	if plugin.Name == "" {
		return &Error{Code: InvalidComposition, Message: "plugin name is empty"}
	}
	var startup sync.Mutex
	var initialized, closed bool
	var startupErr error
	server := &pluginrpc.Server{}
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
		if len(r.tools) > 0 {
			source := &toolSource{tools: r.tools, server: server}
			sr := pluginrpc.SourceRegistration{ID: "tools"}
			for _, t := range source.Tools(api.Session{}) {
				sr.Tools = append(sr.Tools, portable.Tool(t))
			}
			reg.ToolSources = []pluginrpc.SourceRegistration{sr}
			server.Sources = map[string]api.ToolSource{sr.ID: source}
		}
		server.Providers = map[string]api.Provider{}
		for _, p := range r.providers {
			provider := providerAdapter{p}
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
				answer, err := hook.handle(ctx, p)
				return answer, serveFault(err)
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
				text, err := c.Run(ctx, args, &CommandContext{SessionID: str("sessionId"), ActorID: str("actorId")})
				return pluginrpc.Object{"output": text}, serveFault(err)
			}
		}
		server.Registration = reg
		return nil
	}
	err := server.Serve(ctx, in, out)
	startup.Lock()
	closed = true
	startup.Unlock()
	if initialized && plugin.Stop != nil {
		err = errors.Join(err, plugin.Stop())
	}
	if startupErr != nil {
		return startupErr
	}
	if ctx.Err() != nil {
		return appError(ctx.Err(), CancelledCode)
	}
	return appError(err, Lost)
}
func canServe(r *Registrar) error {
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
	return fault
}
