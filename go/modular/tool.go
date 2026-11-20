package modular

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"sync/atomic"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/google/jsonschema-go/jsonschema"
)

type ToolDefinition struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Parameters   json.RawMessage `json:"parameters"`
	Returns      json.RawMessage `json:"returns,omitempty"`
	Hints        ToolHints       `json:"hints"`
	Parallel     bool            `json:"parallel"`
	Callers      []string        `json:"callers"`
	Presentation json.RawMessage `json:"presentation,omitempty"`
}
type ToolHints struct {
	ReadOnly     bool `json:"readOnly"`
	Destructive  bool `json:"destructive"`
	OpenWorld    bool `json:"openWorld"`
	SafeToRepeat bool `json:"safeToRepeat"`
}

type Tool struct {
	definition ToolDefinition
	run        func(context.Context, json.RawMessage, *ToolContext) (any, error)
	invalid    error
	only       bool
}

func (t Tool) Definition() ToolDefinition {
	d := t.definition
	d.Parameters = slices.Clone(d.Parameters)
	d.Returns = slices.Clone(d.Returns)
	d.Presentation = slices.Clone(d.Presentation)
	d.Callers = slices.Clone(d.Callers)
	return d
}

type ToolOption func(*Tool)

func ReadOnly() ToolOption          { return func(t *Tool) { t.definition.Hints.ReadOnly = true } }
func Destructive(v bool) ToolOption { return func(t *Tool) { t.definition.Hints.Destructive = v } }
func OpenWorld(v bool) ToolOption   { return func(t *Tool) { t.definition.Hints.OpenWorld = v } }
func SafeToRepeat() ToolOption      { return func(t *Tool) { t.definition.Hints.SafeToRepeat = true } }
func Parallel() ToolOption          { return func(t *Tool) { t.definition.Parallel = true } }
func Callers(v ...string) ToolOption {
	return func(t *Tool) { t.definition.Callers = append([]string{}, v...) }
}
func InProcessOnly() ToolOption { return func(t *Tool) { t.only = true } }
func Presentation(v json.RawMessage) ToolOption {
	return func(t *Tool) { t.definition.Presentation = slices.Clone(v) }
}
func Output[T any]() ToolOption {
	return func(t *Tool) {
		schema, err := jsonschema.For[T](nil)
		if err == nil {
			t.definition.Returns, _, err = resolve(schema)
		}
		if err != nil {
			t.invalid = err
		}
	}
}
func resolve(schema *jsonschema.Schema) (json.RawMessage, *jsonschema.Resolved, error) {
	schema.Schema = "https://json-schema.org/draft/2020-12/schema"
	r, err := schema.Resolve(nil)
	if err != nil {
		return nil, nil, err
	}
	b, err := json.Marshal(schema)
	return b, r, err
}
func NewTool[In, Out any](name, description string, run func(context.Context, In, *ToolContext) (Out, error), opts ...ToolOption) Tool {
	t := Tool{definition: ToolDefinition{Name: name, Description: description, Hints: ToolHints{Destructive: true, OpenWorld: true}, Callers: []string{"model", "ui", "plugin"}}}
	for _, opt := range opts {
		opt(&t)
	}
	if t.invalid != nil {
		return t
	}
	if run == nil || name == "" || description == "" {
		t.invalid = errors.New("tool requires a name, description and function")
		return t
	}
	s, err := jsonschema.For[In](nil)
	if err != nil {
		t.invalid = err
		return t
	}
	return withToolSchema(t, s, run)
}

// NewSchemaTool uses an explicit JSON Schema object, or that object as json.RawMessage.
func NewSchemaTool[In, Out any](name, description string, schema any, run func(context.Context, In, *ToolContext) (Out, error), opts ...ToolOption) Tool {
	t := Tool{definition: ToolDefinition{Name: name, Description: description, Hints: ToolHints{Destructive: true, OpenWorld: true}, Callers: []string{"model", "ui", "plugin"}}}
	for _, opt := range opts {
		opt(&t)
	}
	if t.invalid != nil {
		return t
	}
	if run == nil || name == "" || description == "" {
		t.invalid = errors.New("tool requires a name, description and function")
		return t
	}
	raw, err := json.Marshal(schema)
	if err != nil || len(raw) == 0 || raw[0] != '{' {
		t.invalid = errors.New("tool input schema must be a JSON Schema object")
		return t
	}
	var s jsonschema.Schema
	if t.invalid = json.Unmarshal(raw, &s); t.invalid != nil {
		return t
	}
	t = withToolSchema(t, &s, run)
	t.definition.Parameters = raw
	return t
}

func withToolSchema[In, Out any](t Tool, s *jsonschema.Schema, run func(context.Context, In, *ToolContext) (Out, error)) Tool {
	var validator *jsonschema.Resolved
	t.definition.Parameters, validator, t.invalid = resolve(s)
	t.run = func(ctx context.Context, input json.RawMessage, tc *ToolContext) (any, error) {
		var in In
		var raw any
		if err := json.Unmarshal(input, &raw); err != nil {
			return nil, &Error{Code: InvalidRequest, Message: err.Error()}
		}
		if err := validator.Validate(raw); err != nil {
			return nil, &Error{Code: InvalidRequest, Message: err.Error()}
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return nil, &Error{Code: InvalidRequest, Message: err.Error()}
		}
		return run(ctx, in, tc)
	}
	return t
}

type ToolOutput struct {
	Status  ToolStatus `json:"status,omitempty"`
	Content Content    `json:"content"`
	Value   any        `json:"value,omitempty"`
}
type ToolContext struct {
	Tools                      ToolCalls
	Environment                ToolEnvironment
	SessionID, ActorID, CallID string
	ctx                        context.Context
	settled                    atomic.Bool
	refused                    atomic.Pointer[string]
	ask                        func(context.Context, Question, AskOptions) (Answer, error)
	progress                   func(string)
	host                       api.API
	server                     *pluginrpc.Server
	plugin                     string
	only                       bool
}

func (t *ToolContext) Cancelled() <-chan struct{} { return t.ctx.Done() }

type refusal string

func (e refusal) Error() string { return string(e) }
func (t *ToolContext) Refuse(reason string) error {
	if t.settled.Load() {
		return &Error{Code: InvalidRequest, Message: "tool call has settled"}
	}
	if reason == "" {
		reason = "tool refused"
	}
	t.refused.CompareAndSwap(nil, &reason)
	return refusal(reason)
}
func (t *ToolContext) Ask(ctx context.Context, q Question, options ...AskOptions) (Answer, error) {
	if t.settled.Load() {
		return Answer{}, &Error{Code: InvalidRequest, Message: "tool call has settled"}
	}
	if q.Kind != "approval" && q.Kind != "text" && q.Kind != "choice" && q.Kind != "link" && q.Kind != "secret" {
		return Answer{}, &Error{Code: NotSupported, Message: "unsupported question kind " + q.Kind}
	}
	if q.Kind == "choice" && len(q.Options) == 0 {
		return Answer{}, &Error{Code: InvalidRequest, Message: "choice needs options"}
	}
	var opt AskOptions
	if len(options) > 1 {
		return Answer{}, &Error{Code: InvalidRequest, Message: "at most one ask option"}
	}
	if len(options) == 1 {
		opt = options[0]
	}
	if opt.Then != "" && (opt.Then != "leaveOpen" || opt.Wait <= 0) {
		return Answer{}, &Error{Code: InvalidRequest, Message: "leaveOpen requires a positive wait"}
	}
	work, cancel := context.WithCancel(t.ctx)
	stop := context.AfterFunc(ctx, cancel)
	defer func() { stop(); cancel() }()
	if ctx.Err() != nil {
		cancel()
	}
	return t.ask(work, q, opt)
}
func (t *ToolContext) Progress(content Content) error {
	if t.settled.Load() {
		return &Error{Code: InvalidRequest, Message: "tool call has settled"}
	}
	if t.ctx.Err() != nil {
		return appError(t.ctx.Err(), CancelledCode)
	}
	if !api.ToolProgress(t.ctx, portable.ReadContent(content)) {
		t.progress(content.Text())
	}
	return nil
}
func (t *ToolContext) Log(message string) {
	if !t.settled.Load() {
		fmt.Fprintln(os.Stderr, message)
	}
}

type toolSource struct {
	tools  []Tool
	a      api.API
	server *pluginrpc.Server
	plugin string
}

func (s *toolSource) Tools(api.Session) []api.Tool {
	defs := make([]api.Tool, 0, len(s.tools))
	for _, t := range s.tools {
		var obj portable.Object
		_ = decodeInto(t.definition, &obj)
		defs = append(defs, portable.ReadTool(obj))
	}
	return defs
}
func (s *toolSource) Run(ctx context.Context, session api.Session, call api.Call, progress func(string)) api.ToolResult {
	tc := &ToolContext{SessionID: session.ID, ActorID: call.Actor, CallID: call.ID, ctx: ctx, progress: progress, host: s.a, server: s.server, plugin: s.plugin}
	tc.Tools = ToolCalls{tc: tc, port: api.InvocationTools(ctx)}
	tc.Environment = ToolEnvironment{tc: tc, project: session.Project}
	if s.server != nil {
		tc.Environment.port = s.server.HostEnvironment()
	} else if s.a != nil {
		if v, err := s.a.Get("working-environment"); err == nil {
			tc.Environment.port, _ = v.(api.WorkingEnvironment)
		}
	}
	defer tc.settled.Store(true)
	tc.ask = func(ctx context.Context, q Question, opt AskOptions) (Answer, error) {
		wait, leaveOpen := opt.Wait, opt.Then == "leaveOpen"
		if s.server != nil {
			var out Answer
			req := pluginrpc.Object{"kind": q.Kind, "question": q.Question}
			if q.Credential != "" {
				req["credential"] = q.Credential
			}
			if len(q.Options) > 0 {
				req["options"] = q.Options
			}
			if len(q.Details) > 0 {
				req["details"] = q.Details
			}
			if wait > 0 {
				req["timeLimitMs"] = max(1, wait.Milliseconds())
			}
			if leaveOpen {
				req["whenTimeLimit"] = "leaveOpen"
			}
			var response struct {
				Answer
				Pending bool `json:"pending"`
			}
			err := s.server.Callback(ctx, "host/ask", pluginrpc.Object{"sessionId": session.ID, "request": req}, &response)
			if response.Pending {
				return out, LeftOpen
			}
			if response.Stored != "" {
				response.Value = response.Stored
			}
			return response.Answer, appError(err, Internal)
		}
		value, err := s.a.Get("questions")
		if err != nil {
			return Answer{}, appError(err, NotSupported)
		}
		if policy, ok := s.a.(interface{ LateQuestions() bool }); leaveOpen && (!ok || !policy.LateQuestions()) {
			return Answer{}, &Error{Code: NotSupported, Message: "leaving a call open is not supported"}
		}
		e := api.Executing(ctx)
		ans, err := value.(api.Questions).Ask(ctx, api.Question{Session: session.ID, Turn: e.Turn, Step: e.Call.Step, Call: call.ID, Actor: call.Actor, Kind: q.Kind, Prompt: q.Question, Options: q.Options, Details: q.Details, Credential: q.Credential, Wait: wait, Defer: leaveOpen})
		if errors.Is(err, api.ErrQuestionOpen) {
			return Answer{}, LeftOpen
		}
		var declined *api.QuestionDeclined
		if errors.As(err, &declined) {
			return Decline(declined.Reason), nil
		}
		return Answer{Value: ans.Value, Declined: ans.Declined, Reason: ans.Reason, Stored: ans.Stored}, appError(err, InvalidRequest)
	}
	for _, t := range s.tools {
		if t.definition.Name != call.Name {
			continue
		}
		tc.only = t.only
		output, err := t.run(ctx, call.Input, tc)
		tc.settled.Store(true)
		result := api.ToolResult{Call: call.ID, Name: call.Name, Status: "completed"}
		fail := func(status ToolStatus, message string) api.ToolResult {
			result.Status = portable.StatusIn(string(status))
			result.Content = api.Text(message)
			return result
		}
		if ctx.Err() != nil {
			return fail(Cancelled, "tool call cancelled")
		}
		if reason := tc.refused.Load(); reason != nil {
			return fail(Refused, *reason)
		}
		if errors.Is(err, LeftOpen) {
			result.Status = "open"
			return result
		}
		if err != nil {
			return fail(Failed, err.Error())
		}
		var value any
		var hasValue bool
		schema := len(t.definition.Returns) != 0
		switch v := output.(type) {
		case string:
			if !schema {
				result.Content = api.Text(v)
			} else {
				value, hasValue = v, true
			}
		case Content:
			result.Content = portable.ReadContent(v)
		case ToolOutput:
			switch v.Status {
			case "", Completed, Failed, Refused, OutcomeUnknown:
			default:
				return fail(Failed, "invalid tool output status")
			}
			if v.Status != "" {
				result.Status = portable.StatusIn(string(v.Status))
			}
			result.Content = portable.ReadContent(v.Content)
			value, hasValue = v.Value, v.Value != nil
		default:
			if !schema {
				return fail(Failed, "tool returned a value without an output schema")
			}
			value, hasValue = v, true
		}
		if hasValue {
			b, err := json.Marshal(value)
			if err != nil {
				if result.Status != "completed" || !schema {
					return fail(Failed, err.Error())
				}
				// The host will check the missing value at settlement, after hooks.
				result.Content = api.Text("Tool could not encode its result value.")
			} else {
				result.Structured = b
			}
		}
		if len(result.Content) == 0 {
			if result.Status != "completed" {
				result.Content = api.Text("tool ended with status " + portable.StatusOut(result.Status))
			} else if result.Structured != nil {
				result.Content = api.Text(string(result.Structured))
			}
		}
		return result
	}
	return api.ToolResult{Call: call.ID, Name: call.Name, Status: "failed", Content: api.Text("unknown tool")}
}
