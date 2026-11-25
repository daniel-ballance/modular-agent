package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
)

func (p *turnPorts) RunTool(ctx context.Context, call api.Call) (result api.ToolResult) {
	defer func() {
		if result.NotDispatched {
			toolDisposition(ctx, call, result.Status)
		}
	}()
	plugin, id, def, source, snap, found := p.resolveTool(call.Name)
	if !found || !api.CanCall(def, call.Origin) || !p.canRunTools(call.Actor) {
		return api.ToolResult{Call: call.ID, Status: "refused", NotDispatched: true}
	}
	if err := validateToolInput(def, call.Input); err != nil {
		return api.ToolResult{Call: call.ID, Status: "failed", Content: api.Text(err.Error()), NotDispatched: true}
	}
	if ctx.Err() != nil || p.CheckWriter() != nil || !p.canRunTools(call.Actor) {
		return api.ToolResult{Call: call.ID, Status: "not_started", NotDispatched: true}
	}
	binding := api.ToolRegistration{Plugin: plugin, ToolSource: id}
	q := api.Executing(ctx).LiveApproval
	if p.c.h.SupportsWaitingApprovals() {
		if sources, err := p.waitingProof(ctx, snap, call, &binding, &def, true); err != nil {
			return api.ToolResult{Call: call.ID, Status: api.GateFailureStatus(err), NotDispatched: true}
		} else if len(sources) != 0 {
			// Use the immutable request that was answered, not today's composition default.
			q = &api.WaitingApprovals(snap)[call.ID].Question
		}
	}
	var cover *approvalCover
	if p.c.h.approvalCoversNested && q != nil && q.CoversNested {
		if q.ID == "" || !sameApprovalCall(*q, call, &binding, &def) {
			return api.ToolResult{Call: call.ID, Status: "refused", NotDispatched: true}
		}
		cover = &approvalCover{ToolCallID: call.ID, RequestID: q.ID}
	}
	result, err := p.executeTool(ctx, source, snap, call, binding, 0, cover)
	result.Returns = def.Output
	if err != nil {
		result.ProcessingError = err
	}
	return result
}

func (c *client) CallTool(ctx context.Context, id string, call api.Call) (api.ToolResult, error) {
	s, err := c.find(id)
	if err != nil {
		return api.ToolResult{}, err
	}
	s.mu.Lock()
	if ctx.Err() != nil || !c.authorizedBy(s.data, ctx, "tools") {
		s.mu.Unlock()
		return api.ToolResult{}, api.ErrAuthority
	}
	if err := s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return api.ToolResult{}, err
	}
	if s.pendingStore != nil {
		s.mu.Unlock()
		return api.ToolResult{}, errProvisionalSession
	}
	if s.rewindBlocked {
		s.mu.Unlock()
		return api.ToolResult{}, errRewindUnresolved
	}
	if err := s.checkWriterLocked(); err != nil {
		s.mu.Unlock()
		return api.ToolResult{}, err
	}
	if s.running || s.opening || s.closing {
		s.mu.Unlock()
		return api.ToolResult{}, errors.New("session busy")
	}
	s.running = true
	s.done = make(chan struct{})
	callCtx, cancel := context.WithCancelCause(telemetry.Scope(ctx, id, "", "", c.h.agentName))
	s.cancel = cancel
	snap := clone(s.data)
	s.mu.Unlock()
	defer func() {
		interrupted := callCtx.Err() != nil
		cancel(nil)
		s.mu.Lock()
		close(s.done)
		if len(s.queue) > 0 && !s.closing && !interrupted && s.writerFailure == nil {
			in := s.queue[0]
			s.queue = s.queue[1:]
			s.activeActor = in.Actor
			s.done = make(chan struct{})
			nextCtx, nextCancel := context.WithCancelCause(context.Background())
			s.cancel = nextCancel
			go c.h.run(nextCtx, s, in)
		} else {
			s.running = false
		}
		s.mu.Unlock()
	}()
	call.ID = api.ID()
	call.Actor = api.Acting(ctx)
	call.Origin = "ui"
	v, err := c.Get("runtime")
	if err != nil {
		return api.ToolResult{}, err
	}
	runner, ok := v.(interface {
		RunCall(context.Context, api.Turn, api.Call) (api.ToolResult, error)
	})
	if !ok {
		return api.ToolResult{}, errors.New("Runtime cannot run external calls")
	}
	var tools []api.Tool
	seen := map[string]bool{}
	for _, source := range c.All("tools.") {
		for _, tool := range source.(api.ToolSource).Tools(snap) {
			if seen[tool.Name] {
				return api.ToolResult{}, errors.New("duplicate tool " + tool.Name)
			}
			seen[tool.Name] = true
			tools = append(tools, tool)
		}
	}
	c.h.mu.RLock()
	owner := c.h.caps["runtime"].owner
	c.h.mu.RUnlock()
	ports := &turnPorts{c: &client{h: c.h, owner: owner}, s: s, actor: call.Actor, tools: tools, input: api.Input{ConnectionRights: api.ConnectionRights(ctx)}}
	canRepeat := true
	if env, e := c.Get("working-environment"); e == nil {
		canRepeat = env.(api.WorkingEnvironment).StopsOnCrash()
	}
	result, err := runner.RunCall(callCtx, api.Turn{Session: id, Actor: call.Actor, Tools: tools, IO: ports, CanRepeat: canRepeat}, call)
	if errors.Is(context.Cause(callCtx), api.ErrProcessStopped) {
		return api.ToolResult{}, api.ErrSessionLost
	}
	if err != nil {
		return result, err
	}
	out, err := c.OutputValue(ctx, api.Event{Kind: "tool.result", Session: id, Data: api.JSON(result)})
	if err != nil {
		return api.ToolResult{}, err
	}
	return api.Decode[api.ToolResult](out.Data), nil
}
