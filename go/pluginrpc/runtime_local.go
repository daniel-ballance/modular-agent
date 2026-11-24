package pluginrpc

import (
	"context"
	"sync/atomic"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// RuntimeCallback is the request-scoped host port shared by local and served
// binding-shaped Runtimes. A local invocation needs no transport or handshake.
type RuntimeCallback func(context.Context, string, Object) (any, error)

type BindingRuntime interface {
	Declaration() api.RuntimeDeclaration
	RunBinding(context.Context, string, Object, RuntimeCallback) (any, error)
}

type localRuntime struct {
	BindingRuntime
	host api.API
}

func LocalRuntime(host api.API, impl BindingRuntime) api.Runtime {
	return localRuntime{impl, host}
}

func (r localRuntime) SupportsEmptyContinuation() bool { return r.Declaration().InterfaceTools }

func (r localRuntime) Run(ctx context.Context, t api.Turn) api.Outcome {
	return runRuntimeHost(ctx, t, r.host, r.Declaration(), func(ctx context.Context, w *runtimeWork, method string, params object) (object, error) {
		var active atomic.Bool
		active.Store(true)
		defer active.Store(false)
		result, err := r.RunBinding(ctx, method, params, func(call context.Context, method string, args Object) (any, error) {
			if !active.Load() {
				return nil, fault("invalid_request", "Runtime turn context has settled")
			}
			// Normalize shared JSON values the same way the binding parser does.
			return w.callback(call, ctx, nil, nil, method, obj(mustJSON(args)))
		})
		return asObject(result), err
	})
}
