package harness

import (
	"context"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
)

func (c *client) CallTool(ctx context.Context, id string, call api.Call) (api.ToolResult, error) {
	s, err := c.find(id)
	if err != nil {
		return api.ToolResult{}, err
	}
	s.mu.Lock()
	if s.rewindBlocked {
		s.mu.Unlock()
		return api.ToolResult{}, errRewindUnresolved
	}
	if s.running || s.opening || s.closing {
		s.mu.Unlock()
		return api.ToolResult{}, errors.New("session busy")
	}
	s.running = true
	s.done = make(chan struct{})
	callCtx, cancel := context.WithCancelCause(ctx)
	s.cancel = cancel
	snap := clone(s.data)
	s.mu.Unlock()
	defer func() {
		interrupted := callCtx.Err() != nil
		cancel(nil)
		s.mu.Lock()
		close(s.done)
		if len(s.queue) > 0 && !s.closing && !interrupted {
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
	ports := &turnPorts{c: &client{h: c.h, owner: owner}, s: s, actor: call.Actor, tools: tools}
	canRepeat := true
	if env, e := c.Get("working-environment"); e == nil {
		canRepeat = env.(api.WorkingEnvironment).StopsOnCrash()
	}
	result, err := runner.RunCall(callCtx, api.Turn{Session: id, Actor: call.Actor, Tools: tools, IO: ports, CanRepeat: canRepeat}, call)
	if err != nil {
		return result, err
	}
	out, err := c.OutputValue(ctx, api.Event{Kind: "tool.result", Session: id, Data: api.JSON(result)})
	if err != nil {
		return api.ToolResult{}, err
	}
	return api.Decode[api.ToolResult](out.Data), nil
}
