// Package systemprompt builds the turn's system prompt using the working environment.
package systemprompt

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"io/fs"
)

func Plugin() api.Plugin {
	return api.Plugin{Name: "system-prompt", Setup: func(a api.API) error {
		return a.Handle("turn.prepare", "", func(ctx context.Context, v any) (api.Decision, error) {
			before := v.(api.BeforeTurn)
			prompt := "You are a helpful agent. Use tools when facts require inspecting files or running commands. Relative paths and commands use this session's project. Report tool failures honestly."
			env, err := a.Get("working-environment")
			if err != nil {
				return api.Decision{}, err
			}
			b, err := env.(api.WorkingEnvironment).Read(ctx, before.Session.Project, "AGENTS.md")
			// Project instructions are optional augmentation. A plugin
			// without a read method cannot supply them; never read from a
			// different environment or ignore permission and I/O failures.
			if err != nil && !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, errors.ErrUnsupported) {
				return api.Decision{}, err
			}
			if len(b) > 0 {
				prompt += "\n\nProject AGENTS.md:\n" + string(b)
			}
			before.System += prompt
			last := ""
			for _, e := range before.Session.Branch() {
				if e.Kind == "system" {
					last = e.Content.Text()
				}
			}
			if last != before.System {
				if _, err = a.Record(ctx, before.Session.ID, api.Entry{Kind: "system", Content: api.Text(before.System)}); err != nil {
					return api.Decision{}, err
				}
			}
			return api.Decision{Value: before}, nil
		})
	}}
}
