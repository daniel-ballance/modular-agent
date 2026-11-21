package modular

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

type hookContextKey struct{}

// HookContext is valid for the lifetime of the invoking handler.
type HookContext struct {
	SessionID, ActorID, TurnID, StepID, CallID string
	work                                       *ToolContext
}

func HookContextFrom(ctx context.Context) *HookContext {
	c, _ := ctx.Value(hookContextKey{}).(*HookContext)
	return c
}
func (c *HookContext) History(ctx context.Context, cursor ...string) (HistoryPage, error) {
	if c.SessionID == "" {
		return HistoryPage{}, &Error{Code: InvalidRequest, Message: "hook has no session"}
	}
	return c.work.History(ctx, cursor...)
}
func (c *HookContext) Emit(ctx context.Context, kind string, data any) error {
	if c.SessionID == "" {
		return &Error{Code: InvalidRequest, Message: "hook has no session"}
	}
	return c.work.Emit(ctx, kind, data)
}
func (c *HookContext) Log(message string)         { c.work.Log(message) }
func (c *HookContext) Cancelled() <-chan struct{} { return c.work.Cancelled() }

func withHookContext(ctx context.Context, host api.API, server *pluginrpc.Server, plugin string, p pluginrpc.Object, fn func(context.Context, pluginrpc.Object) (any, error)) (any, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	get := func(k string) string { v, _ := p[k].(string); return v }
	ex := api.Executing(ctx)
	c := &HookContext{SessionID: get("sessionId"), ActorID: get("actorId"), TurnID: get("turnId"), StepID: get("stepId"), CallID: ex.Call.ID}
	if c.ActorID == "" && server == nil {
		c.ActorID = api.Acting(ctx)
	}
	if c.SessionID == "" {
		c.SessionID = ex.Session
	}
	if c.TurnID == "" {
		c.TurnID = ex.Turn
	}
	if c.StepID == "" {
		c.StepID = ex.Step
	}
	if call, ok := p["call"]; ok && c.CallID == "" {
		var parsed ToolCall
		_ = decodeInto(call, &parsed)
		c.CallID = parsed.ID
	}
	c.work = &ToolContext{SessionID: c.SessionID, ActorID: c.ActorID, CallID: c.CallID, ctx: ctx, host: host, server: server, plugin: plugin}
	defer c.work.settled.Store(true)
	return fn(context.WithValue(ctx, hookContextKey{}, c), p)
}

type HookRule string

const (
	Observe     HookRule = "observe"
	GateHook    HookRule = "gate"
	Transform   HookRule = "transform"
	Collect     HookRule = "collect"
	FirstAnswer HookRule = "firstAnswer"
)

// DefineHook registers an in-process hook owned by this plugin.
func (r *Registrar) DefineHook(name string, rule HookRule) error {
	if !strings.Contains(name, ".") || pluginrpc.IsHook(name) || name == "provider.piece" || name == "session.join" || name == "session.leave" || name == "session.prepare" {
		return r.fail(errors.New("invalid custom hook name: " + name))
	}
	if err := r.add("hook:" + name); err != nil {
		return err
	}
	if r.defined == nil {
		r.defined = map[string]HookRule{}
	}
	switch rule {
	case Observe, GateHook, Transform, Collect, FirstAnswer:
	default:
		return r.fail(errors.New("invalid custom hook rule"))
	}
	r.defined[name] = rule
	return nil
}

// CallHook invokes an owned custom hook from an in-process-only tool.
func (t *ToolContext) CallHook(ctx context.Context, name string, payload any) (any, error) {
	return callCustom(ctx, t, name, payload)
}
func callCustom(ctx context.Context, t *ToolContext, name string, payload any) (any, error) {
	var out any
	err := t.callback(ctx, func(ctx context.Context) error {
		if t.server != nil || !t.only {
			return &Error{Code: NotSupported, Message: "calling custom hooks requires InProcessOnly"}
		}
		var err error
		out, err = t.host.Invoke(ctx, name, payload)
		return err
	})
	return out, appError(err, InvalidRequest)
}

func coreHookRule(rule HookRule) api.Rule {
	if rule == FirstAnswer {
		return api.FirstAnswer
	}
	return api.Rule(rule)
}

func customDecision(answer any) (api.Decision, error) {
	if answer == nil {
		return api.Decision{}, nil
	}
	var a map[string]json.RawMessage
	if err := decodeInto(answer, &a); err != nil {
		return api.Decision{}, err
	}
	if raw := a["refuse"]; raw != nil {
		var message string
		_ = json.Unmarshal(raw, &message)
		return api.Decision{}, errors.New(message)
	}
	if raw := a["value"]; raw != nil {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return api.Decision{}, err
		}
		return api.Decision{Value: value, Answer: true}, nil
	}
	return api.Decision{}, nil
}
