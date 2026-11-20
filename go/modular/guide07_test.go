package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type previewHarbour struct {
	Harbour string `json:"harbour"`
}

func tidePreview(recordEnd func(string)) modular.Plugin {
	return modular.Plugin{Name: "tide-preview", Setup: func(r *modular.Registrar) error {
		system := func(text string) func(context.Context, modular.TurnBefore) (modular.TurnContribution, error) {
			return func(context.Context, modular.TurnBefore) (modular.TurnContribution, error) {
				return modular.TurnContribution{System: text}, nil
			}
		}
		return errors.Join(
			r.OnTurnBefore(system("Give the local time.")),
			r.OnTurnBefore(system("Keep the report short."), modular.HookOrder(modular.Last)),
			r.OnTurnBefore(system("Report high tides."), modular.HookOrder(modular.First)),
			r.OnToolBefore(func(_ context.Context, call modular.ToolBefore) (modular.Gate, error) {
				if call.Call.Name != "preview_tide" {
					return modular.Gate{}, nil
				}
				var input previewHarbour
				if err := json.Unmarshal(call.Call.Input, &input); err != nil {
					return modular.Gate{}, err
				}
				switch input.Harbour {
				case "closed":
					return modular.Gate{Refuse: "That station is closed."}, nil
				case "old-town":
					return modular.Gate{Input: json.RawMessage(`{"harbour": "Whitby"}`)}, nil
				default:
					return modular.Gate{}, nil
				}
			}),
			r.OnToolAfter(func(_ context.Context, call modular.ToolAfter) (modular.ToolChange, error) {
				if call.Call.Name == "preview_tide" && call.Result.Status == modular.Completed {
					content := modular.Text("Preview: " + call.Result.Text())
					return modular.ToolChange{Content: &content}, nil
				}
				return modular.ToolChange{}, nil
			}),
			r.OnStepAfter(func(context.Context, modular.StepAfter) (modular.StepDecision, error) {
				return modular.StepDecision{End: "Preview stops after one step."}, nil
			}),
			r.OnTurnEnd(func(_ context.Context, turn modular.TurnEnd) error {
				recordEnd(turn.Outcome.Kind)
				return nil
			}),
		)
	}}
}

func TestPreviewsTidesInProcessAndServed(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for _, served := range []bool{false, true} {
		ended := make(chan string, 1)
		plugin := tidePreview(func(kind string) { ended <- kind })
		placement := modular.WithPlugin(plugin)
		if served {
			placement = modulartest.OverWire(plugin)
		}
		preview := modular.NewTool("preview_tide", "Find a high tide.",
			func(_ context.Context, input previewHarbour, _ *modular.ToolContext) (string, error) {
				return input.Harbour + ": 14:02", nil
			}, modular.ReadOnly())
		agent := modulartest.Agent(t, placement, modular.WithTool(preview), modulartest.Script(`[
			{"toolCalls": [
				{"name": "preview_tide", "input": {"harbour": "old-town"}},
				{"name": "preview_tide", "input": {"harbour": "closed"}}
			]},
			{"text": "This step must not run."}
		]`))
		session, err := agent.Session(ctx)
		if err != nil {
			t.Fatal(err)
		}
		turn, err := session.Prompt(ctx, "Preview the high tides.")
		if err != nil {
			t.Fatal(err)
		}
		results := turn.ToolResults()
		if len(results) != 2 || results[0].Status != modular.Completed ||
			results[0].Text() != "Preview: Whitby: 14:02" || results[1].Status != modular.Refused ||
			!strings.Contains(results[1].Text(), "That station is closed.") {
			t.Fatalf("unexpected results: %+v", results)
		}
		if turn.Outcome == nil || turn.Outcome.Kind != "failed" ||
			!strings.Contains(turn.Outcome.Error, "Preview stops after one step.") || turn.Text != "" {
			t.Fatalf("unexpected turn: %+v", turn)
		}
		history, err := session.History(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var start struct{ System string }
		for _, entry := range history {
			if entry["kind"] == "turnStart" {
				raw, err := json.Marshal(entry["data"])
				if err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(raw, &start); err != nil {
					t.Fatal(err)
				}
			}
		}
		if strings.Join(strings.Fields(start.System), " ") !=
			"Report high tides. Give the local time. Keep the report short." {
			t.Fatalf("unexpected prompt: %q", start.System)
		}
		select {
		case kind := <-ended:
			if kind != "failed" {
				t.Fatalf("unexpected observed outcome: %s", kind)
			}
		case <-ctx.Done():
			t.Fatal("last observer didn't run")
		}
	}
}
