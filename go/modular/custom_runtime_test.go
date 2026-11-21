package modular_test

import (
	"context"
	"errors"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type demoRuntime struct{}

func (demoRuntime) Declaration() modular.RuntimeSupport { return modular.RuntimeSupport{} }
func (demoRuntime) ResumeTurn(context.Context, modular.RuntimeInput, modular.InterruptedTurn, *modular.RuntimeContext) (modular.TurnOutcome, error) {
	return modular.TurnOutcome{}, errors.New("unexpected resume")
}
func (demoRuntime) ContinueOpenCalls(context.Context, modular.RuntimeInput, []modular.PendingCall, *modular.RuntimeContext) (modular.TurnOutcome, error) {
	return modular.TurnOutcome{}, errors.New("unexpected continuation")
}
func (demoRuntime) RunTurn(ctx context.Context, turn modular.RuntimeInput, c *modular.RuntimeContext) (modular.TurnOutcome, error) {
	var out modular.TurnOutcome
	page, err := c.History(ctx)
	if err != nil {
		return out, err
	}
	if turn.StartedBy.ID == "" || turn.StartedBy.Kind != "actor" || len(page.Entries) == 0 {
		return out, errors.New("missing checkpoint")
	}
	step, err := c.NewID(ctx)
	if err != nil {
		return out, err
	}
	req, err := c.PrepareStep(ctx, step, modular.Usage{})
	if err != nil {
		return out, err
	}
	msg, err := c.Model(ctx, step, req)
	if err != nil {
		return out, err
	}
	row, err := c.Record(ctx, modular.HistoryEntry{"kind": "response", "stepId": step, "message": msg})
	if err != nil {
		return out, err
	}
	if _, err = c.Hook(ctx, "step.after", modular.HookPayload{"stepId": step, "response": msg}); err != nil {
		return out, err
	}
	out.Outcome.Kind = "completed"
	out.Result.Text = msg.Content.Text()
	out.Entries = []string{row["id"].(string)}
	out.Usage = msg.Usage
	return out, nil
}

func TestCustomRuntimeInProcessAndOverWire(t *testing.T) {
	p := modular.Plugin{Name: "demo-runtime", Replaces: []string{"runtime"}, Setup: func(r *modular.Registrar) error { return r.Runtime(modular.NewRuntime(demoRuntime{})) }}
	for name, opt := range map[string]modular.Option{"inProcess": modular.WithPlugin(p), "overWire": modulartest.OverWire(p)} {
		t.Run(name, func(t *testing.T) {
			a := modulartest.Agent(t, opt, modulartest.Script(`[{"text":"Hello from inference."}]`))
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			got, err := s.Prompt(t.Context(), "Hello")
			if err != nil || got.Outcome == nil || got.Outcome.Kind != "completed" || got.Text != "Hello from inference." {
				t.Fatalf("turn: %+v, outcome: %+v, err: %v", got, got.Outcome, err)
			}
		})
	}
}
