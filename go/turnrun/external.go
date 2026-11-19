package turnrun

import (
	"context"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
)

func remaining(t api.Turn, calls []api.Call) []api.Call {
	s, _ := t.IO.Snapshot()
	pending := api.OpenCalls(s)
	var out []api.Call
	for _, c := range calls {
		for _, p := range pending {
			if c.ID == p.ID {
				out = append(out, p)
			}
		}
	}
	return out
}

// RunCall uses the identical checks, execution and recording pipeline without inference.
func (r *Runner) RunCall(ctx context.Context, t api.Turn, call api.Call) (api.ToolResult, error) {
	if !t.Resume {
		if _, err := t.IO.Record(ctx, api.Entry{Kind: "external.start", Call: call.ID, Data: api.JSON(api.ExternalStart{Call: call, Tools: t.Tools})}); err != nil {
			return api.ToolResult{}, err
		}
	}
	if _, err := r.calls(ctx, t, "", "", []api.Call{call}, t.Resume && !r.Durable); err != nil {
		return api.ToolResult{}, err
	}
	s, err := t.IO.Snapshot()
	if err != nil {
		return api.ToolResult{}, err
	}
	for _, e := range s.Branch() {
		if e.Kind == "tool.result" && e.Call == call.ID {
			return api.Decode[api.ToolResult](e.Data), nil
		}
	}
	if len(remaining(t, []api.Call{call})) > 0 {
		return api.ToolResult{Call: call.ID, Status: "open"}, nil
	}
	return api.ToolResult{}, errors.New("call has no result")
}
