package modular_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestStandardTypedHookPoints(t *testing.T) {
	for _, remote := range []bool{false, true} {
		name := "inProcess"
		if remote {
			name = "overWire"
		}
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			var mu sync.Mutex
			seen := map[string]int{}
			mark := func(point string) { mu.Lock(); seen[point]++; mu.Unlock() }
			hooks := modular.Plugin{Name: "typed", Setup: func(r *modular.Registrar) error {
				regs := []error{
					r.OnSessionStart(func(_ context.Context, p modular.SessionStart) error {
						if p.SessionID != "" {
							mark("session.start")
						}
						return nil
					}),
					r.OnSessionEnd(func(_ context.Context, id string) error {
						if id != "" {
							mark("session.end")
						}
						return nil
					}),
					r.OnInput(func(_ context.Context, p modular.InputHook) (modular.InputChange, error) {
						if p.Content.Text() == "original" && p.ActorID != "" {
							mark("input")
						}
						c := modular.Text("changed")
						return modular.InputChange{Content: &c}, nil
					}),
					r.OnTurnBefore(func(_ context.Context, p modular.TurnBefore) (modular.TurnContribution, error) {
						if p.Input.Text() == "changed" {
							mark("turn.before")
						}
						return modular.TurnContribution{System: "contribution"}, nil
					}),
					r.OnTurnStart(func(_ context.Context, p modular.TurnStart) error {
						if p.TurnID != "" {
							mark("turn.start")
						}
						return nil
					}),
					r.OnStepBefore(func(_ context.Context, p modular.StepBefore) (*modular.ModelRequest, error) {
						if strings.Contains(p.Request.SystemPrompt, "contribution") {
							mark("step.before")
						}
						p.Request.SystemPrompt += " step"
						return &p.Request, nil
					}),
					r.OnStepAfter(func(_ context.Context, p modular.StepAfter) (modular.StepDecision, error) {
						if p.StepID != "" {
							mark("step.after")
						}
						return modular.StepDecision{}, nil
					}),
					r.OnToolBefore(func(_ context.Context, p modular.ToolBefore) (modular.Gate, error) {
						if p.Call.Name == "demo" {
							mark("tool.before")
						}
						return modular.Gate{Input: []byte(`{"value":"rewritten"}`)}, nil
					}),
					r.OnToolAfter(func(_ context.Context, p modular.ToolAfter) (modular.ToolChange, error) {
						if p.Result.Text() == "rewritten" {
							mark("tool.after")
						}
						c := modular.Text("finished tool")
						return modular.ToolChange{Content: &c}, nil
					}),
					r.OnProviderRequest(func(_ context.Context, p modular.ProviderRequest) (*modular.ModelRequest, error) {
						if strings.Contains(p.Request.SystemPrompt, "step") {
							mark("provider.request")
						}
						return nil, nil
					}),
					r.OnProviderResponse(func(_ context.Context, p modular.ProviderResponse) error {
						if p.Message.Role == "assistant" {
							mark("provider.response")
						}
						return nil
					}),
					r.OnTurnResult(func(_ context.Context, p modular.TurnResultCheck) (modular.Gate, error) {
						if p.Result.Text == "done" {
							mark("turn.result")
						}
						return modular.Gate{}, nil
					}),
					r.OnTurnEnd(func(_ context.Context, p modular.TurnEnd) error {
						if p.Outcome.Kind == "completed" {
							mark("turn.end")
						}
						return nil
					}),
					r.OnOutput(func(_ context.Context, p modular.OutputBatch) (modular.OutputDecision, error) {
						if len(p.Events) > 0 {
							mark("output")
						}
						return modular.OutputDecision{}, nil
					}),
					r.OnModelFailed(func(_ context.Context, p modular.ModelFailed) (*modular.RetryDecision, error) {
						if p.Error.Message == "offline failure" {
							mark("model.failed")
						}
						return &modular.RetryDecision{Retry: false}, nil
					}),
				}
				if !remote {
					regs = append(regs,
						r.OnPluginLoad(func(_ context.Context, p modular.PluginLoad) (modular.Gate, error) {
							if p.Name == "next" {
								mark("plugin.load")
							}
							return modular.Gate{}, nil
						}),
						r.OnSessionPrepare(func(_ context.Context, p modular.SessionPrepare) error {
							if p.Project != "" {
								mark("session.prepare")
							}
							return nil
						}),
						r.OnSessionJoin(func(_ context.Context, p modular.ActorChange) error {
							if p.Actor.ID == "reader" {
								mark("session.join")
							}
							return nil
						}),
						r.OnSessionLeave(func(_ context.Context, p modular.ActorChange) error {
							if p.Actor.ID == "reader" {
								mark("session.leave")
							}
							return nil
						}),
						r.OnProviderPiece(func(_ context.Context, p modular.ProviderPiece) error {
							if p.Piece.Type == "text" {
								mark("provider.piece")
							}
							return nil
						}),
						r.OnStepBeforeChange(func(_ context.Context, p modular.StepBefore) (modular.StepChange, error) {
							if len(p.History) > 0 && p.ProviderTools != nil {
								mark("providerTools")
							}
							none := []modular.ToolDefinition{}
							return modular.StepChange{ProviderTools: &none}, nil
						}, modular.HookInProcessOnly()),
					)
				}
				return errors.Join(regs...)
			}}
			opt := modular.WithPlugin(hooks)
			if remote {
				opt = modulartest.OverWire(hooks)
			}
			type args struct {
				Value string `json:"value"`
			}
			tool := modular.NewTool("demo", "demo", func(_ context.Context, p args, _ *modular.ToolContext) (string, error) { return p.Value, nil })
			a := modulartest.Agent(t, opt, modular.WithPlugin(modular.Plugin{Name: "next"}), modular.WithSeveralActors(true), modular.WithTool(tool), modulartest.Script(`[{"toolCalls":[{"name":"demo","input":{"value":"initial"}}]},{"text":"done"},{"error":{"kind":"other","message":"offline failure"}}]`))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Join(ctx, modular.Actor{ID: "reader", Kind: "program", Rights: []string{"watch"}}); err != nil {
				t.Fatal(err)
			}
			if err = s.Leave(ctx, "reader"); err != nil {
				t.Fatal(err)
			}
			got, err := s.Prompt(ctx, "original")
			if err != nil || got.Text != "done" || len(got.ToolResults()) != 1 || got.ToolResults()[0].Text() != "finished tool" {
				t.Fatalf("prompt: %+v (%+v): %v", got, got.Outcome, err)
			}
			if got, err = s.Prompt(ctx, "original"); err != nil || got.Outcome == nil || got.Outcome.Kind != "failed" {
				t.Fatalf("failed prompt: %+v %v", got, err)
			}
			if err = s.Close(ctx); err != nil {
				t.Fatal(err)
			}
			want := strings.Fields("session.start session.end input turn.before turn.start step.before step.after tool.before tool.after provider.request provider.response turn.result turn.end output model.failed")
			if !remote {
				want = append(want, strings.Fields("plugin.load session.prepare session.join session.leave provider.piece providerTools")...)
			}
			mu.Lock()
			defer mu.Unlock()
			for _, p := range want {
				if seen[p] == 0 {
					t.Errorf("typed hook did not receive its payload: %s", p)
				}
			}
		})
	}
}
