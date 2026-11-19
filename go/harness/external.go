package harness

import (
	"context"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
)

func externalRecovery(s api.Session) []api.Call {
	by := map[string]api.Call{}
	var order []string
	for _, e := range s.Branch() {
		if e.WasKind("tool.result") {
			delete(by, e.Call)
			continue
		}
		switch e.Kind {
		case "external.start":
			start := api.Decode[api.ExternalStart](e.Data)
			by[start.Call.ID] = start.Call
			order = append(order, start.Call.ID)
		case "tool.open":
			delete(by, e.Call)
		}
	}
	var out []api.Call
	for _, id := range order {
		if c, ok := by[id]; ok {
			out = append(out, c)
		}
	}
	return out
}
func (h *Harness) runExternal(ctx context.Context, s *session, calls []api.Call) api.Outcome {
	runtime, err := h.API().Get("runtime")
	if err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	runner, ok := runtime.(interface {
		RunCall(context.Context, api.Turn, api.Call) (api.ToolResult, error)
	})
	if !ok {
		return api.Outcome{Status: "failed", Error: "Runtime cannot recover external calls"}
	}
	snap, err := h.API().Snapshot(s.id)
	if err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	var tools []api.Tool
	for _, source := range h.API().All("tools.") {
		tools = append(tools, source.(api.ToolSource).Tools(snap)...)
	}
	h.mu.RLock()
	owner := h.caps["runtime"].owner
	h.mu.RUnlock()
	canRepeat := true
	if env, e := h.API().Get("working-environment"); e == nil {
		canRepeat = env.(api.WorkingEnvironment).StopsOnCrash()
	}
	out := api.Outcome{Status: "completed"}
	for _, call := range calls {
		ports := &turnPorts{c: &client{h: h, owner: owner}, s: s, actor: call.Actor, tools: tools}
		result, e := runner.RunCall(ctx, api.Turn{Session: s.id, Actor: call.Actor, Resume: true, CanRepeat: canRepeat, Tools: tools, IO: ports}, call)
		if e != nil && !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			return api.Outcome{Status: "failed", Error: e.Error()}
		}
		if result.Status == "open" {
			out.Open = append(out.Open, call)
		} else {
			out.Result = result.Content
		}
	}
	return out
}
