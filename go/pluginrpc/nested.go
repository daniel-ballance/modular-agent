package pluginrpc

import (
	"context"
	"encoding/json"

	"github.com/daniel-ballance/modular-agent/go/api"
)

type servedTools struct {
	s   *Server
	ctx context.Context
}

func (t servedTools) request(ctx context.Context, method string, params Object, out any) error {
	if t.ctx.Err() != nil {
		return fault("invalid_request", "tool invocation ended")
	}
	linked, cancel := context.WithCancel(t.ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return t.s.Callback(linked, method, params, out)
}
func (t servedTools) List(ctx context.Context) ([]api.Tool, error) {
	var response struct {
		Tools []object `json:"tools"`
	}
	if err := t.request(ctx, "host/tools/list", Object{}, &response); err != nil {
		return nil, err
	}
	tools := make([]api.Tool, 0, len(response.Tools))
	for _, v := range response.Tools {
		tools = append(tools, toolIn(v))
	}
	return tools, nil
}
func (t servedTools) Call(ctx context.Context, name string, input json.RawMessage) (api.ToolResult, error) {
	var result object
	if err := t.request(ctx, "host/tools/call", Object{"name": name, "input": input}, &result); err != nil {
		return api.ToolResult{}, err
	}
	r := resultIn(result)
	r.Name = name
	return r, nil
}

func NestDefinition() api.Tool {
	return api.Tool{Name: "nest", Description: "Conformance fixture: call another registered tool", Destructive: true, External: true, Input: json.RawMessage(`{"type":"object","required":["name","input"],"properties":{"name":{"type":"string"},"input":{}}}`)}
}
func Nest(ctx context.Context, call api.Call) api.ToolResult {
	var in struct {
		Name  string
		Input json.RawMessage
	}
	tools := api.InvocationTools(ctx)
	if json.Unmarshal(call.Input, &in) != nil || in.Name == "" || in.Input == nil || tools == nil {
		return api.ToolResult{Status: "failed", Content: api.Text("invalid_request")}
	}
	result, err := tools.Call(ctx, in.Name, in.Input)
	if err != nil {
		return api.ToolResult{Status: "failed", Content: api.Text(Code(err))}
	}
	return result
}

func NestFixture() api.Plugin {
	return api.Plugin{Name: "nested-conformance", Setup: func(a api.API) error { return a.Provide("tools.nested-conformance", nestFixture{}) }}
}

type nestFixture struct{}

func (nestFixture) Tools(api.Session) []api.Tool { return []api.Tool{NestDefinition()} }
func (nestFixture) Run(ctx context.Context, _ api.Session, call api.Call, _ func(string)) api.ToolResult {
	return Nest(ctx, call)
}
