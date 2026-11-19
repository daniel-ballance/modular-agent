// Package commands turns slash input into plugin commands, never model input.
package commands

import (
	"context"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"strings"
)

func Plugin() api.Plugin {
	return api.Plugin{Name: "commands", Setup: func(a api.API) error {
		commands := map[string]api.Command{
			"usage": func(ctx context.Context, id string, _ []string) (string, error) {
				s, err := a.Snapshot(id)
				return string(api.JSON(api.SessionUsage(s))), err
			},
			"help": func(context.Context, string, []string) (string, error) {
				return "/" + strings.Join(a.Commands(), ", /"), nil
			},
			"settings": func(ctx context.Context, id string, args []string) (string, error) {
				s, err := a.Snapshot(id)
				return string(api.JSON(s.Settings)), err
			},
			"history": func(ctx context.Context, id string, args []string) (string, error) {
				s, err := a.View(ctx, id)
				return string(api.JSON(s)), err
			},
			"move": func(ctx context.Context, id string, args []string) (string, error) {
				if len(args) != 1 {
					return "", errors.New("usage: /move entry-id")
				}
				return "Moved.", a.Move(ctx, id, args[0], false)
			},
			"fork": func(ctx context.Context, id string, args []string) (string, error) {
				if len(args) > 1 {
					return "", errors.New("usage: /fork [entry-id]")
				}
				point := ""
				if len(args) > 0 {
					point = args[0]
				}
				return a.Fork(ctx, id, point)
			},
			"erase": func(ctx context.Context, id string, args []string) (string, error) {
				if len(args) != 1 {
					return "", errors.New("usage: /erase entry-id")
				}
				return "Erased controlled history copies. Output already delivered is out of reach.", a.Erase(ctx, id, args)
			},
			"sessions": func(ctx context.Context, id string, args []string) (string, error) {
				s, err := a.Snapshot(id)
				if err != nil {
					return "", err
				}
				project := s.Project
				if len(args) == 1 && args[0] == "all" {
					project = ""
				} else if len(args) > 0 {
					return "", errors.New("usage: /sessions [all]")
				}
				list, err := a.List(project)
				if err != nil {
					return "", err
				}
				var lines []string
				for _, s := range list {
					lines = append(lines, fmt.Sprintf("%s %s", s.ID, s.Project))
				}
				return strings.Join(lines, "\n"), nil
			},
			"support": func(context.Context, string, []string) (string, error) {
				holding := false
				if v, err := a.Get("output-policy"); err == nil {
					holding = v.(bool)
				}
				declaration := api.RuntimeDeclaration{}
				if v, err := a.Get("runtime"); err == nil {
					declaration = v.(api.Runtime).Declaration()
				}
				durableChildren := false
				if v, err := a.Get("subagents"); err == nil {
					if d, ok := v.(interface{ Durable() bool }); ok {
						durableChildren = d.Durable()
					}
				}
				cleanup := false
				if v, err := a.Get("working-environment"); err == nil {
					cleanup = v.(api.WorkingEnvironment).StopsOnCrash()
				}
				return string(api.JSON(map[string]bool{"steering": declaration.Steering, "fork": true, "keyed_input": true, "erasure": true, "holds_output": holding, "durable_turns": declaration.Durable, "parallel_tools": declaration.Parallel, "rewind": false, "multiple_actors": true, "live_models": false, "provider_tools": false, "autonomous_turns": has(a, "jobs"), "managed_jobs": has(a, "jobs"), "subagents": has(a, "subagents"), "durable_subagents": durableChildren, "input_requests": has(a, "questions"), "open_calls": has(a, "questions"), "sigkill_command_cleanup": cleanup, "dynamic_plugins": false, "waits_through_restart": declaration.Durable && has(a, "questions"), "questions_outlast_turn": has(a, "questions"), "provider_state": false, "late_models": false, "output_bypasses_gate": false, "cancel_cancels_jobs": false})), nil
			},
		}
		for name, fn := range commands {
			if err := a.RegisterCommand(name, fn); err != nil {
				return err
			}
		}
		return a.Handle("input", "first", func(ctx context.Context, v any) (api.Decision, error) {
			event := v.(api.InputEvent)
			line := event.Input.Content.Text()
			if !strings.HasPrefix(strings.TrimSpace(line), "/") {
				return api.Decision{Value: event}, nil
			}
			if event.Input.Key != "" {
				return api.Decision{}, errors.New("keyed slash commands are not supported; key model input instead")
			}
			result, err := a.Command(ctx, event.Session, strings.TrimSpace(line))
			if err != nil {
				return api.Decision{}, err
			}
			event.Handled = true
			event.Result = result
			return api.Decision{Value: event, Stop: true}, nil
		})
	}}
}
