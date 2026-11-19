package api

import (
	"context"
	"encoding/json"
)

// NestedTools is an invocation-scoped port. It cannot start a turn.
type NestedTools interface {
	List(context.Context) ([]Tool, error)
	Call(context.Context, string, json.RawMessage) (ToolResult, error)
}
type nestedKey struct{}

func WithNestedTools(ctx context.Context, tools NestedTools) context.Context {
	return context.WithValue(ctx, nestedKey{}, tools)
}
func InvocationTools(ctx context.Context) NestedTools {
	tools, _ := ctx.Value(nestedKey{}).(NestedTools)
	return tools
}
