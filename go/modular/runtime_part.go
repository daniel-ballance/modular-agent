package modular

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"sync/atomic"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

// RuntimeImplementation receives the same turn and checkpoint in every placement.
type RuntimeImplementation interface {
	Declaration() RuntimeSupport
	RunTurn(context.Context, RuntimeInput, *RuntimeContext) (TurnOutcome, error)
	ResumeTurn(context.Context, RuntimeInput, InterruptedTurn, *RuntimeContext) (TurnOutcome, error)
	ContinueOpenCalls(context.Context, RuntimeInput, []PendingCall, *RuntimeContext) (TurnOutcome, error)
}

type RuntimeSupport struct {
	InputDuringTurn       bool `json:"inputDuringTurn"`
	WaitingThroughRestart bool `json:"waitingThroughRestart"`
	ContinuesAfterRestart bool `json:"continuesAfterRestart"`
}

type StartedBy struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type RuntimeInput struct {
	SessionID     string                 `json:"sessionId"`
	TurnID        string                 `json:"turnId"`
	StartedBy     StartedBy              `json:"startedBy"`
	Model         ModelInfo              `json:"model"`
	ModelSupports RuntimeProviderSupport `json:"modelSupports"`
	Settings      TurnSettings           `json:"settings"`
	ResultShape   json.RawMessage        `json:"resultShape,omitempty"`
}
type RuntimeProviderSupport struct {
	KeepsState   bool `json:"keepsState"`
	RunsTools    bool `json:"runsTools"`
	SafeToRepeat bool `json:"safeToRepeat,omitempty"`
}
type TurnSettings struct {
	MaxSteps  int    `json:"maxSteps,omitempty"`
	MaxOutput int    `json:"maxOutput,omitempty"`
	Reasoning string `json:"reasoning,omitempty"`
}
type PendingCall struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Input        json.RawMessage `json:"input"`
	StepID       string          `json:"stepId,omitempty"`
	Started      bool            `json:"started"`
	SafeToRepeat bool            `json:"safeToRepeat"`
}
type AnsweredStep struct {
	StepID string `json:"stepId"`
	// Decision is nil if not committed, JSON null for allow, or a refusal object.
	Decision json.RawMessage `json:"decision,omitempty"`
}
type InterruptedTurn struct {
	TurnID   string        `json:"turnId"`
	Calls    []PendingCall `json:"calls"`
	LastStep *AnsweredStep `json:"lastStep,omitempty"`
}
type TurnOutcome struct {
	Outcome Outcome    `json:"outcome"`
	Result  TurnResult `json:"result"`
	Entries []string   `json:"entries"`
	Usage   Usage      `json:"usage"`
}

// NewRuntime adapts binding-shaped Runtime methods for the Registrar and WithRuntime.
func NewRuntime(impl RuntimeImplementation) Runtime {
	if impl == nil {
		return nil
	}
	return runtimePart{impl, impl.Declaration()}
}

type runtimePart struct {
	impl    RuntimeImplementation
	support RuntimeSupport
}

func (r runtimePart) Declaration() RuntimeDeclaration {
	d := r.support
	return RuntimeDeclaration{Durable: d.ContinuesAfterRestart, Steering: d.InputDuringTurn, WaitingThroughRestart: d.WaitingThroughRestart, NestedToolCalls: true}
}
func (r runtimePart) Run(context.Context, RuntimeTurn) RuntimeOutcome {
	return RuntimeOutcome{Status: "failed", Error: "Runtime must be installed through the SDK"}
}
func (r runtimePart) RunBinding(ctx context.Context, method string, params pluginrpc.Object, invoke pluginrpc.RuntimeCallback) (any, error) {
	var turn RuntimeInput
	if err := decodeInto(params["turn"], &turn); err != nil {
		return nil, serveFault(appError(err, InvalidRequest))
	}
	c := &RuntimeContext{Turn: turn, call: invoke}
	c.active.Store(true)
	defer c.active.Store(false)
	var out TurnOutcome
	var err error
	switch method {
	case "runtime/runTurn":
		out, err = r.impl.RunTurn(ctx, turn, c)
	case "runtime/resumeTurn":
		var checkpoint InterruptedTurn
		if err = decodeInto(params["interrupted"], &checkpoint); err == nil {
			out, err = r.impl.ResumeTurn(ctx, turn, checkpoint, c)
		}
	case "runtime/continueOpenCalls":
		var calls []PendingCall
		if err = decodeInto(params["calls"], &calls); err == nil {
			out, err = r.impl.ContinueOpenCalls(ctx, turn, calls, c)
		}
	}
	if out.Entries == nil {
		out.Entries = []string{}
	}
	if out.Result.OpenToolCalls == nil {
		out.Result.OpenToolCalls = []string{}
	}
	return out, serveFault(err)
}

// RuntimeContext exposes the binding's turn-scoped host operations. It does
// not grant access to a Provider or tool except through these callbacks.
type RuntimeContext struct {
	Turn   RuntimeInput
	active atomic.Bool
	call   pluginrpc.RuntimeCallback
}

func (c *RuntimeContext) callback(ctx context.Context, method string, args pluginrpc.Object, out any) error {
	if !c.active.Load() {
		return &Error{Code: InvalidRequest, Message: "Runtime context has settled"}
	}
	value, err := c.call(ctx, method, args)
	if err != nil {
		return appError(err, InvalidRequest)
	}
	if out == nil {
		return nil
	}
	return appError(decodeInto(value, out), InvalidRequest)
}
func (c *RuntimeContext) NewID(ctx context.Context) (string, error) {
	var out struct{ ID string }
	err := c.callback(ctx, "host/runtime/newId", pluginrpc.Object{}, &out)
	return out.ID, err
}
func (c *RuntimeContext) PrepareStep(ctx context.Context, stepID string, usage Usage) (ModelRequest, error) {
	var raw json.RawMessage
	err := c.callback(ctx, "host/runtime/prepareStep", pluginrpc.Object{"stepId": stepID, "usage": usage}, &raw)
	var out ModelRequest
	if err == nil {
		err = json.Unmarshal(raw, &out)
		out.runtimeWire = raw
	}
	return out, err
}
func (c *RuntimeContext) Model(ctx context.Context, stepID string, request ModelRequest, piece ...func(ModelStreamEvent)) (AssistantMessage, error) {
	if len(piece) > 1 {
		return AssistantMessage{}, &Error{Code: InvalidRequest, Message: "expected at most one piece handler"}
	}
	if len(piece) == 1 && piece[0] != nil {
		ctx = pluginrpc.WithRuntimePieces(ctx, func(p api.Part) {
			var v ModelStreamEvent
			v.Type = p.Type
			v.Delta = p.Text
			_ = json.Unmarshal(p.Wire, &v)
			piece[0](v)
		})
	}
	var raw json.RawMessage
	wire := runtimeValue(request, request.runtimeWire)
	err := c.callback(ctx, "host/runtime/model", pluginrpc.Object{"stepId": stepID, "request": wire}, &raw)
	var out AssistantMessage
	if err == nil {
		err = json.Unmarshal(raw, &out)
		out.runtimeWire = raw
	}
	return out, err
}

// Retain opaque fields of an unchanged binding value, but never silently
// substitute the original for a request the Runtime actually edited.
func runtimeValue[T any](value T, wire json.RawMessage) any {
	var original T
	if len(wire) > 0 && json.Unmarshal(wire, &original) == nil && bytes.Equal(api.JSON(value), api.JSON(original)) {
		return wire
	}
	return value
}

type ModelStreamEvent struct {
	Type       string `json:"type"`
	Delta      string `json:"delta"`
	ToolCallID string `json:"toolCallId,omitempty"`
}

func (c *RuntimeContext) Hook(ctx context.Context, point string, payload HookPayload) (HookAnswer, error) {
	if msg, ok := payload["response"].(AssistantMessage); ok {
		copy := maps.Clone(payload)
		copy["response"] = runtimeValue(msg, msg.runtimeWire)
		payload = copy
	}
	var out HookAnswer
	err := c.callback(ctx, "host/runtime/hook", pluginrpc.Object{"hook": point, "payload": payload}, &out)
	return out, err
}
func (c *RuntimeContext) Definition(ctx context.Context, name string) (*ToolDefinition, error) {
	var out *ToolDefinition
	err := c.callback(ctx, "host/runtime/definition", pluginrpc.Object{"toolName": name}, &out)
	return out, err
}

type RuntimeToolResult struct {
	ToolResult
	Pending string `json:"pending,omitempty"`
}

func (c *RuntimeContext) RunToolCall(ctx context.Context, call ToolCall) (RuntimeToolResult, error) {
	var out RuntimeToolResult
	err := c.callback(ctx, "host/runtime/runToolCall", pluginrpc.Object{"call": call}, &out)
	return out, err
}
func (c *RuntimeContext) Record(ctx context.Context, entry HistoryEntry) (HistoryEntry, error) {
	if msg, ok := entry["message"].(AssistantMessage); ok {
		copy := maps.Clone(entry)
		copy["message"] = runtimeValue(msg, msg.runtimeWire)
		entry = copy
	}
	var out HistoryEntry
	err := c.callback(ctx, "host/runtime/record", pluginrpc.Object{"entry": entry}, &out)
	return out, err
}
func (c *RuntimeContext) TakeSteering(ctx context.Context, final bool) ([]HistoryEntry, error) {
	var out struct{ Entries []HistoryEntry }
	err := c.callback(ctx, "host/runtime/takeSteering", pluginrpc.Object{"final": final}, &out)
	return out.Entries, err
}
func (c *RuntimeContext) HasSteering(ctx context.Context) (bool, error) {
	var out struct{ Waiting bool }
	err := c.callback(ctx, "host/runtime/hasSteering", pluginrpc.Object{}, &out)
	return out.Waiting, err
}
func (c *RuntimeContext) History(ctx context.Context, cursor ...string) (HistoryPage, error) {
	var out HistoryPage
	args := pluginrpc.Object{"sessionId": c.Turn.SessionID}
	if len(cursor) > 0 {
		args["cursor"] = cursor[0]
	}
	err := c.callback(ctx, "host/history", args, &out)
	return out, err
}
func (c *RuntimeContext) Report(ctx context.Context, kind string, data any, stepID, toolCallID string) error {
	return c.callback(ctx, "host/runtime/report", pluginrpc.Object{"type": kind, "data": data, "stepId": stepID, "toolCallId": toolCallID}, nil)
}
