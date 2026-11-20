package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

// MaxNestedDepth counts edges below a model or UI call.
const MaxNestedDepth = 8

type invocation struct {
	p       *turnPorts
	ctx     context.Context
	cancel  context.CancelCauseFunc
	call    api.Call
	depth   int
	mu      sync.Mutex
	closed  bool
	work    sync.WaitGroup
	failure error
}

var errInactiveInvocation = errors.New("tool invocation is not active")

func (i *invocation) begin(ctx context.Context) (context.Context, func(), error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.closed || i.ctx.Err() != nil || ctx.Err() != nil || !i.p.canRunTools(i.call.Actor) {
		return nil, nil, errInactiveInvocation
	}
	if err := i.p.CheckWriter(); err != nil {
		return nil, nil, err
	}
	i.work.Add(1)
	child, cancel := context.WithCancelCause(i.ctx)
	stop := context.AfterFunc(ctx, func() { cancel(context.Cause(ctx)) })
	return child, func() { stop(); cancel(nil); i.work.Done() }, nil
}

func (i *invocation) finish() error {
	i.mu.Lock()
	i.closed = true
	cause := context.Cause(i.ctx)
	i.cancel(cause)
	i.mu.Unlock()
	i.work.Wait()
	return i.failure
}

func (i *invocation) List(ctx context.Context) ([]api.Tool, error) {
	_, done, err := i.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	snap, err := i.p.Snapshot()
	if err != nil {
		return nil, err
	}
	list := []api.Tool{}
	for _, source := range i.p.c.All("tools.") {
		for _, tool := range source.(api.ToolSource).Tools(snap) {
			if api.CanCall(tool, "tool") {
				list = append(list, tool)
			}
		}
	}
	sort.Slice(list, func(a, b int) bool { return list[a].Name < list[b].Name })
	return list, nil
}

func (i *invocation) Call(ctx context.Context, name string, input json.RawMessage) (api.ToolResult, error) {
	if name == "" || !json.Valid(input) {
		return api.ToolResult{}, errors.New("invalid nested tool name or input")
	}
	ctx, done, err := i.begin(ctx)
	if err != nil {
		return api.ToolResult{}, err
	}
	defer done()
	call := api.Call{ID: api.ID(), ParentCall: i.call.ID, Name: name, Input: input, Origin: "tool", Actor: i.call.Actor, Step: i.call.Step}
	result, err := i.p.runNested(ctx, call, i.depth+1)
	if err != nil && !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
		i.mu.Lock()
		i.failure = errors.Join(i.failure, err)
		i.mu.Unlock()
	}
	return result, err
}

func validateToolInput(def api.Tool, input json.RawMessage) error {
	if len(def.Input) == 0 {
		return nil
	}
	resolved, err := api.ResolveSchema(def.Input)
	if err != nil {
		return err
	}
	return api.ValidateJSON(resolved, input)
}

func (p *turnPorts) runNested(ctx context.Context, call api.Call, depth int) (api.ToolResult, error) {
	requested, err := p.Record(context.WithoutCancel(ctx), api.Entry{Kind: "tool.call", Step: call.Step, Call: call.ID, Data: api.JSON(call)})
	if err != nil {
		return api.ToolResult{}, err
	}
	p.Emit(ctx, api.Event{Kind: "tool.requested", Step: call.Step, Call: call.ID, Data: api.JSON(call)})
	result := api.ToolResult{Status: "refused"}
	fail := func(status, reason string) { result.Status, result.Content = status, api.Text(reason) }
	var processing error
	for {
		if ctx.Err() != nil {
			fail("not_started", "Parent invocation ended before dispatch.")
			break
		}
		if depth > MaxNestedDepth {
			fail("refused", "Maximum nested tool depth exceeded.")
			break
		}
		plugin, source, def, executor, snap, ok := p.resolveTool(call.Name)
		if !ok || !api.CanCall(def, "tool") {
			fail("refused", "Tool is not registered for plugin calls.")
			break
		}
		binding := api.ToolRegistration{Plugin: plugin, ToolSource: source}
		definition := portable.Tool(def)
		changed, err := p.Hook(api.WithNestedTools(ctx, nil), "runtime.tool.before", api.ToolCheck{Session: p.s.id, Turn: p.id, Call: call, Definition: def})
		check, _ := changed.(api.ToolCheck)
		if errors.Is(err, api.ErrQuestionOpen) || check.Open {
			fail("refused", "Nested calls cannot be left open.")
			break
		}
		if err != nil {
			fail("refused", err.Error())
			break
		}
		if check.Refused != "" {
			fail("refused", check.Refused)
			break
		}
		final := call
		final.Input = check.Call.Input
		if err := validateToolInput(def, final.Input); err != nil {
			fail("failed", err.Error())
			break
		}
		if check.Validate != nil {
			if err := check.Validate(final); err != nil {
				fail("refused", err.Error())
				break
			}
		}
		// Re-resolve after waits, and after the durable checkpoint below. A
		// registration change invalidates both the gate decision and the approval.
		same := func() bool {
			pn, sn, d, ex, current, found := p.resolveTool(call.Name)
			if !found || pn != plugin || sn != source || !portable.EqualJSON(api.JSON(definition), api.JSON(portable.Tool(d))) {
				return false
			}
			executor, snap = ex, current
			return true
		}
		if !same() {
			continue
		}
		repeat := false // No nested call is independently repeatable.
		start, err := p.Record(ctx, api.Entry{Kind: "tool.started", Step: call.Step, Call: call.ID, Data: api.JSON(final), SafeToRepeat: &repeat, OpenWorld: &def.External, Copies: []string{requested.ID}, Wire: api.JSON(map[string]any{"data": map[string]any{"definition": definition, "source": binding}})})
		if err != nil {
			return api.ToolResult{}, err
		}
		requested = start
		if !same() {
			continue
		}
		if check.Validate != nil {
			if err := check.Validate(final); err != nil {
				fail("refused", err.Error())
				break
			}
		}
		if ctx.Err() != nil || !p.canRunTools(call.Actor) {
			fail("not_started", "Nested dispatch is no longer authorized.")
			break
		}
		if err := p.CheckWriter(); err != nil {
			return api.ToolResult{}, err
		}
		p.Emit(ctx, api.Event{Kind: "tool.started", Step: call.Step, Call: call.ID})
		if ctx.Err() != nil || p.CheckWriter() != nil || !p.canRunTools(call.Actor) {
			fail("not_started", "Nested dispatch is no longer authorized.")
			break
		}
		if !same() {
			continue
		}
		result, processing = p.executeTool(ctx, executor, snap, final, binding, depth)
		result.Returns = def.Output
		call = final
		if result.Status == "open" {
			fail("refused", "Nested calls cannot be left open.")
		}
		break
	}
	if errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
		return api.ToolResult{}, ctx.Err()
	}
	ctx = context.WithoutCancel(ctx)
	if q, err := p.c.Get("questions"); err == nil {
		if close, ok := q.(interface{ CloseCall(string, string) error }); ok {
			if err := close.CloseCall(p.s.id, call.ID); err != nil {
				return api.ToolResult{}, err
			}
		}
	}
	result.Call, result.Name = call.ID, call.Name
	changed, err := p.Hook(api.WithNestedTools(ctx, nil), "runtime.tool.after", api.AfterTool{Call: call, Result: result})
	if check, ok := changed.(api.AfterTool); err == nil && ok {
		result = check.Result
		processing = errors.Join(processing, result.ProcessingError)
	} else if err != nil {
		processing = errors.Join(processing, err)
		result.Content, result.Structured, result.Wire, result.Data = api.Text("Nested result processing failed."), nil, nil, nil
	}
	if _, err = p.Record(ctx, api.Entry{Kind: "tool.result", Step: call.Step, Call: call.ID, Data: api.JSON(result), Content: result.Content, Copies: append([]string{requested.ID}, result.Copies...)}); err != nil {
		return api.ToolResult{}, err
	}
	p.Emit(ctx, api.Event{Kind: "tool.end", Step: call.Step, Call: call.ID, Data: api.JSON(result)})
	if processing != nil {
		p.Emit(ctx, api.Event{Kind: "plugin.problem", Call: call.ID, Data: api.JSON(processing.Error())})
	}
	return result, processing
}

func (p *turnPorts) executeTool(ctx context.Context, source api.ToolSource, snap api.Session, call api.Call, binding api.ToolRegistration, depth int) (result api.ToolResult, err error) {
	live, cancel := context.WithCancelCause(ctx)
	i := &invocation{p: p, ctx: live, cancel: cancel, call: call, depth: depth}
	defer func() {
		if v := recover(); v != nil {
			result = api.ToolResult{Status: "unknown", Content: api.Text(fmt.Sprintf("Tool panic: %v", v))}
		}
		err = i.finish()
	}()
	live = api.WithExecution(live, api.Execution{Session: p.s.id, Turn: p.id, Call: call, ToolSource: &binding})
	live = api.WithNestedTools(live, i)
	progress := func(content api.Content) {
		if live.Err() == nil {
			data := api.JSON(content)
			if len(content) == 1 && content[0].Type == "text" {
				data = api.JSON(content[0].Text)
			}
			p.Emit(live, api.Event{Kind: "tool.progress", Call: call.ID, Step: call.Step, Data: data})
		}
	}
	live = api.WithToolProgress(live, progress)
	return source.Run(live, snap, call, func(text string) { progress(api.Text(text)) }), nil
}
