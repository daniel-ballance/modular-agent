package modular

import (
	"context"
	"encoding/json"
)

func typedHook[P any](r *Registrar, point string, fn func(context.Context, P) (HookAnswer, error), opts []HookOption) error {
	return r.On(point, func(ctx context.Context, p HookPayload) (HookAnswer, error) {
		var v P
		if err := decodeInto(p, &v); err != nil {
			return nil, err
		}
		return fn(ctx, v)
	}, opts...)
}

func observeHook[P any](r *Registrar, point string, fn func(context.Context, P) error, opts []HookOption) error {
	return typedHook(r, point, func(ctx context.Context, p P) (HookAnswer, error) { return nil, fn(ctx, p) }, opts)
}

type HookWork struct{ SessionID, TurnID, StepID, ActorID string }
type PluginLoad struct{ Name, Origin, Project string }
type TurnStart struct{ HookWork }
type ActorChange struct {
	HookWork
	Actor     Actor
	GrantedBy string
}
type InputHook struct {
	HookWork
	Content Content
	When    Timing
}
type InputChange struct {
	Content *Content
	Handle  bool
	Command string
}
type StepBefore struct {
	HookWork
	Model   ModelInfo
	Request ModelRequest
	History []HistoryEntry
	Usage   Usage
	// ProviderTools is the in-process allowance; empty authorizes no tools.
	ProviderTools []ToolDefinition
}

type StepChange struct {
	Request       *ModelRequest
	ProviderTools *[]ToolDefinition
}
type ModelFailed struct {
	HookWork
	Request ModelRequest
	Error   ModelError
}
type RetryDecision struct {
	Retry   bool
	Request *ModelRequest
}
type TurnResultCheck struct {
	HookWork
	Result TurnResult
	Schema json.RawMessage `json:"shape"`
}
type ProviderPiece struct {
	HookWork
	Provider string
	Model    ModelRef
	Piece    Part
}
type OutputBatch struct {
	SessionID, Recipient string
	Events               []DataEvent
	Final                bool
}
type OutputDecision struct {
	Block  bool
	Events *[]DataEvent
}

func (r *Registrar) OnPluginLoad(fn func(context.Context, PluginLoad) (Gate, error), opts ...HookOption) error {
	return typedHook(r, "plugin.load", func(ctx context.Context, p PluginLoad) (HookAnswer, error) {
		a, e := fn(ctx, p)
		if e != nil || a.Refuse == "" {
			return nil, e
		}
		return HookAnswer{"refuse": a.Refuse}, nil
	}, opts)
}
func (r *Registrar) OnTurnStart(fn func(context.Context, TurnStart) error, opts ...HookOption) error {
	return observeHook(r, "turn.start", fn, opts)
}
func (r *Registrar) OnSessionJoin(fn func(context.Context, ActorChange) error, opts ...HookOption) error {
	return observeHook(r, "session.join", fn, opts)
}
func (r *Registrar) OnSessionLeave(fn func(context.Context, ActorChange) error, opts ...HookOption) error {
	return observeHook(r, "session.leave", fn, opts)
}
func (r *Registrar) OnProviderPiece(fn func(context.Context, ProviderPiece) error, opts ...HookOption) error {
	return observeHook(r, "provider.piece", fn, opts)
}
func (r *Registrar) OnInput(fn func(context.Context, InputHook) (InputChange, error), opts ...HookOption) error {
	return typedHook(r, "input", func(ctx context.Context, p InputHook) (HookAnswer, error) {
		a, e := fn(ctx, p)
		if e != nil {
			return nil, e
		}
		if a.Content == nil && !a.Handle && a.Command == "" {
			return nil, nil
		}
		content := p.Content
		if a.Content != nil {
			content = *a.Content
		}
		if a.Command != "" {
			return HookAnswer{"command": a.Command}, nil
		}
		return HookAnswer{"value": map[string]any{"sessionId": p.SessionID, "actorId": p.ActorID, "when": p.When, "content": content}, "stop": a.Handle}, nil
	}, opts)
}
func (r *Registrar) OnStepBefore(fn func(context.Context, StepBefore) (*ModelRequest, error), opts ...HookOption) error {
	return r.OnStepBeforeChange(func(ctx context.Context, p StepBefore) (StepChange, error) {
		req, err := fn(ctx, p)
		return StepChange{Request: req}, err
	}, opts...)
}

// OnStepBeforeChange additionally permits narrowing the local Provider-tool
// allowance. A handler that changes it must register with HookInProcessOnly.
func (r *Registrar) OnStepBeforeChange(fn func(context.Context, StepBefore) (StepChange, error), opts ...HookOption) error {
	return r.On("step.before", func(ctx context.Context, p HookPayload) (HookAnswer, error) {
		var in StepBefore
		if err := decodeInto(p, &in); err != nil {
			return nil, err
		}
		changed, err := fn(ctx, in)
		if err != nil || changed.Request == nil && changed.ProviderTools == nil {
			return nil, err
		}
		if changed.Request != nil {
			req, err := changedRequest(p["request"], *changed.Request)
			if err != nil {
				return nil, err
			}
			p["request"] = req
		}
		if changed.ProviderTools != nil {
			if _, ok := p["providerTools"]; !ok {
				return nil, &Error{Code: NotSupported, Message: "Provider-tool allowance is in-process only"}
			}
			p["providerTools"] = *changed.ProviderTools
		}
		return HookAnswer{"value": p}, nil
	}, opts...)
}
func (r *Registrar) OnModelFailed(fn func(context.Context, ModelFailed) (*RetryDecision, error), opts ...HookOption) error {
	return typedHook(r, "model.failed", func(ctx context.Context, p ModelFailed) (HookAnswer, error) {
		a, err := fn(ctx, p)
		if err != nil || a == nil {
			return nil, err
		}
		result := HookAnswer{"retry": a.Retry}
		if a.Request != nil {
			result["request"] = a.Request
		}
		return result, nil
	}, opts)
}
func (r *Registrar) OnTurnResult(fn func(context.Context, TurnResultCheck) (Gate, error), opts ...HookOption) error {
	return typedHook(r, "turn.result", func(ctx context.Context, p TurnResultCheck) (HookAnswer, error) {
		a, e := fn(ctx, p)
		if e != nil || a.Refuse == "" {
			return nil, e
		}
		return HookAnswer{"refuse": a.Refuse}, nil
	}, opts)
}
func (r *Registrar) OnOutput(fn func(context.Context, OutputBatch) (OutputDecision, error), opts ...HookOption) error {
	return typedHook(r, "output", func(ctx context.Context, p OutputBatch) (HookAnswer, error) {
		a, e := fn(ctx, p)
		if e != nil {
			return nil, e
		}
		if a.Block {
			return HookAnswer{"block": true}, nil
		}
		if a.Events != nil {
			return HookAnswer{"events": *a.Events}, nil
		}
		return nil, nil
	}, opts)
}
