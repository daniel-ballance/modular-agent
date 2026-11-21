package modular

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/transient"
)

// Runtime runs work using the call-scoped ports on RuntimeTurn.
type Runtime = api.Runtime
type RuntimeTurn = api.Turn
type RuntimeOutcome = api.Outcome
type RuntimeDeclaration = api.RuntimeDeclaration

func TransientRuntime() Runtime { return &transient.Runtime{} }
func DurableRuntime() Runtime   { return &durable.Runtime{Durable: true} }

// WithRuntime selects a Runtime explicitly, subject to the durability checks.
func WithRuntime(runtime Runtime) Option {
	return func(o *options) error {
		if runtime == nil {
			return &Error{Code: InvalidParams, Message: "runtime is nil"}
		}
		o.runtime = runtime
		return nil
	}
}

func runtimeSetup(a api.API, runtime Runtime) error {
	for point, rule := range api.RuntimeHooks() {
		if err := a.Define(point, rule); err != nil {
			return err
		}
	}
	if impl, ok := runtime.(pluginrpc.BindingRuntime); ok {
		runtime = pluginrpc.LocalRuntime(a, impl)
	}
	return a.Provide("runtime", runtime)
}

// Runtime registers a replacement Runtime. List "runtime" in Plugin.Replaces
// when the agent already has one.
func (r *Registrar) Runtime(runtime Runtime) error {
	if runtime == nil {
		return r.fail(&Error{Code: InvalidParams, Message: "runtime is nil"})
	}
	if err := r.add("runtime"); err != nil {
		return err
	}
	r.runtime = runtime
	return nil
}

// Environment registers a working environment. List "working-environment"
// in Plugin.Replaces when the agent already has one.
func (r *Registrar) Environment(env Environment) error {
	if env == nil {
		return r.fail(&Error{Code: InvalidParams, Message: "environment is nil"})
	}
	if err := r.add("working-environment"); err != nil {
		return err
	}
	r.environment = env
	return nil
}
