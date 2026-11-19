package modular

import (
	"context"
	"encoding/json"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

// ToolCalls reaches the Harness under the current tool invocation.
type ToolCalls struct {
	tc   *ToolContext
	port api.NestedTools
}

func (t ToolCalls) check() error {
	if t.tc == nil || t.tc.settled.Load() || t.tc.ctx.Err() != nil {
		return &Error{Code: InvalidRequest, Message: "tool call has settled"}
	}
	if t.port == nil {
		return &Error{Code: NotSupported, Message: "nested calls are unavailable"}
	}
	return nil
}
func (t ToolCalls) List(ctx context.Context) ([]ToolDefinition, error) {
	if err := t.check(); err != nil {
		return nil, err
	}
	list, err := t.port.List(ctx)
	if err != nil {
		return nil, appError(err, InvalidRequest)
	}
	out := make([]ToolDefinition, 0, len(list))
	for _, tool := range list {
		out = append(out, api.Decode[ToolDefinition](api.JSON(portable.Tool(tool))))
	}
	return out, nil
}
func (t ToolCalls) Call(ctx context.Context, name string, input any) (ToolResult, error) {
	if err := t.check(); err != nil {
		return ToolResult{}, err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ToolResult{}, appError(err, InvalidRequest)
	}
	r, err := t.port.Call(ctx, name, raw)
	var result ToolResult
	_ = decodeInto(portable.Result(r), &result)
	result.Name = r.Name
	return result, appError(err, InvalidRequest)
}
