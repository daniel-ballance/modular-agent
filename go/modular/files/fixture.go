package files

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/OWNER/modular-agent/go/modular"
)

// FixtureBash is the ACP conformance command tool. Use only with isolated state.
func FixtureBash() modular.Tool {
	return modular.NewSchemaTool("bash", "Execute a bash command.", json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false}`), func(ctx context.Context, in input, tc *modular.ToolContext) (modular.ToolOutput, error) {
		r, err := tc.Environment.Exec(ctx, in.Command, 0, func(s string) { _ = tc.Progress(modular.Text(s)) })
		if err != nil {
			var typed *modular.Error
			if errors.As(err, &typed) && typed.Code == modular.Lost {
				return modular.ToolOutput{Status: modular.OutcomeUnknown, Content: modular.Text(err.Error())}, nil
			}
			return modular.ToolOutput{}, err
		}
		status := modular.Completed
		if r.ExitCode == nil || *r.ExitCode != 0 {
			status = modular.Failed
		}
		return modular.ToolOutput{Status: status, Content: modular.Text(r.Output)}, nil
	})
}
