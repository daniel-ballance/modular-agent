package pluginrpc

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/turnrun"
)

// RunCall applies the host's call pipeline. Out-of-turn calls never make a
// request to the Runtime plugin, including when an interrupted call resumes.
func (r *remoteRuntime) RunCall(ctx context.Context, turn api.Turn, call api.Call) (api.ToolResult, error) {
	runner := turnrun.Runner{Durable: r.Declaration().Durable}
	return runner.RunCall(ctx, turn, call)
}
