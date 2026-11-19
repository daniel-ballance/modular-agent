// Package resultcheck lets a plugin return a model to work within the same turn.
package resultcheck

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
)

// Plugin accepts an empty reason, or records the reason as the next model input.
// The Runtime's normal step limit bounds repeated rejection.
func Plugin(reason func(api.Content) string) api.Plugin {
	return api.Plugin{Name: "result-check", Setup: func(a api.API) error {
		return a.Handle("runtime.result", "", func(_ context.Context, v any) (api.Decision, error) {
			check := v.(api.ResultCheck)
			if check.Continue == "" {
				check.Continue = reason(check.Result)
			}
			return api.Decision{Value: check}, nil
		})
	}}
}
