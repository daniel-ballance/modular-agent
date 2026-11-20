// Package fixtures contains the shared SDK fixtures in both placements.
package fixtures

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type tideInput struct {
	Harbour string `json:"harbour" jsonschema:"The harbour to look up."`
}
type confirmInput struct {
	Question string `json:"question"`
}
type counterInput struct {
	Hold bool    `json:"hold,omitempty" jsonschema:"Wait after counting until cancelled, so a crash lands after the effect."`
	Note *string `json:"note,omitempty"`
}

func Plugin(name string) (modular.Plugin, error) {
	p := modular.Plugin{Name: name}
	switch name {
	case "tide":
		p.Setup = func(r *modular.Registrar) error {
			return r.Tool(modular.NewTool("tide", "Today's high tide at a harbour.", func(_ context.Context, in tideInput, _ *modular.ToolContext) (string, error) {
				return fmt.Sprintf("High tide at %s is 14:02.", in.Harbour), nil
			}, modular.ReadOnly()))
		}
	case "quay":
		p.Setup = func(r *modular.Registrar) error {
			return r.Tool(modular.NewTool("moor", "Moor at a harbour.", func(_ context.Context, _ tideInput, tc *modular.ToolContext) (string, error) {
				return "", tc.Refuse("the quay is closed")
			}))
		}
	case "pilot":
		p.Setup = func(r *modular.Registrar) error {
			return r.Tool(modular.NewTool("pilot", "Ask the tide tool about a harbour.", func(ctx context.Context, in tideInput, tc *modular.ToolContext) (string, error) {
				result, err := tc.Tools.Call(ctx, "tide", in)
				if err != nil {
					return "", err
				}
				return "Pilot: " + result.Text(), nil
			}))
		}
	case "confirm":
		p.Setup = func(r *modular.Registrar) error {
			return r.Tool(modular.NewTool("confirm", "Ask whether to go ahead.", func(ctx context.Context, in confirmInput, tc *modular.ToolContext) (string, error) {
				answer, err := tc.Ask(ctx, modular.Question{Kind: "choice", Question: in.Question, Options: []string{"yes", "no"}})
				if answer.Declined {
					return "declined", err
				}
				return answer.Value, err
			}))
		}
	case "note":
		p.Setup = func(r *modular.Registrar) error {
			return r.Tool(modular.NewTool("note", "Ask for a note.", func(ctx context.Context, in confirmInput, tc *modular.ToolContext) (string, error) {
				a, err := tc.Ask(ctx, modular.Question{Kind: "text", Question: in.Question})
				if a.Declined {
					return "declined", err
				}
				return "value: " + a.Value, err
			}))
		}
	case "gate":
		p.Setup = func(r *modular.Registrar) error {
			return r.OnToolBefore(func(_ context.Context, in modular.ToolBefore) (modular.Gate, error) {
				if bytes.Contains(in.Call.Input, []byte("forbidden")) {
					return modular.Gate{Refuse: "the gate refused it"}, nil
				}
				return modular.Gate{}, nil
			})
		}
	case "counter":
		p.Setup = func(r *modular.Registrar) error {
			path, ok := r.Config()["path"].(string)
			if !ok || path == "" {
				return &modular.Error{Code: modular.InvalidParams, Message: "counter needs a config path"}
			}
			return r.Tool(modular.NewTool("bump", "Add one to a count kept in a file.", func(ctx context.Context, in counterInput, _ *modular.ToolContext) (string, error) {
				next := strconv.Itoa(Count(path) + 1)
				tmp := path + ".tmp"
				if err := os.WriteFile(tmp, []byte(next), 0600); err != nil {
					return "", err
				}
				if err := os.Rename(tmp, path); err != nil {
					return "", err
				}
				if in.Hold {
					<-ctx.Done()
					return "", ctx.Err()
				}
				return next, nil
			}))
		}
	default:
		return modular.Plugin{}, fmt.Errorf("no fixture named %q", name)
	}
	return p, nil
}

func Count(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}
