package modular_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestChecksApprovalPolicy(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for _, tc := range []struct {
		policy               modular.Approval
		readOnly, hasHandler bool
		status               modular.ToolStatus
		asks                 int
	}{
		{"off", false, true, modular.Completed, 0},
		{"ask", true, false, modular.Completed, 0},
		{"ask", false, false, modular.Refused, 0},
		{"ask", false, true, modular.Completed, 1},
		{"all", true, true, modular.Completed, 1},
		{"never", false, true, modular.Refused, 0},
	} {
		var hints []modular.ToolOption
		if tc.readOnly {
			hints = append(hints, modular.ReadOnly())
		}
		preview := modular.NewTool("preview", "Preview a palette.",
			func(context.Context, struct{}, *modular.ToolContext) (string, error) {
				return "Preview ready.", nil
			}, hints...)
		seen := make(chan modular.Question, 4)
		options := []modular.Option{
			modular.WithApproval(tc.policy), modular.WithTool(preview),
			modulartest.Script(`[
				{"toolCalls": [{"name": "preview", "input": {}}]},
				{"text": "Done."}
			]`),
		}
		if tc.hasHandler {
			options = append(options, modular.WithOnQuestion(
				func(_ context.Context, q modular.Question) (modular.Answer, error) {
					seen <- q
					return modular.Allow(), nil
				}))
		}
		agent := modulartest.Agent(t, options...)
		session, err := agent.Session(ctx)
		if err != nil {
			t.Fatal(err)
		}
		turn, err := session.Prompt(ctx, "Preview a palette.")
		if err != nil {
			t.Fatal(err)
		}
		results := turn.ToolResults()
		if len(results) != 1 || results[0].Status != tc.status || len(seen) != tc.asks {
			t.Fatalf("%+v: results %v, questions %d", tc, results, len(seen))
		}
		for range tc.asks {
			q := <-seen
			var input map[string]any
			if q.Kind != "approval" || q.Call == nil || q.Call.Name != "preview" ||
				json.Unmarshal(q.Call.Input, &input) != nil || input == nil || len(input) != 0 {
				t.Fatalf("not the expected approval: %+v", q)
			}
		}
	}
}

var choosePalette = modular.NewTool("choose_palette", "Ask which palette to preview.",
	func(ctx context.Context, _ struct{}, cx *modular.ToolContext) (string, error) {
		answer, err := cx.Ask(ctx, modular.Question{
			Kind: "choice", Question: "Which palette?", Options: []string{"light", "dark"},
		})
		if err != nil {
			return "", err
		}
		if answer.Declined {
			return "", cx.Refuse("No palette selected.")
		}
		return "Selected " + answer.Value + ".", nil
	}, modular.ReadOnly())

func TestAnswersAChoiceFromTheUI(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	agent := modulartest.Agent(t, modular.WithApproval("ask"), modular.WithTool(choosePalette),
		modular.WithOnQuestion(func(context.Context, modular.Question) (modular.Answer, error) {
			return modular.Decline("No UI for this session."), nil
		}),
		modulartest.Script(`[
			{"toolCalls": [{"name": "choose_palette", "input": {}}]},
			{"text": "Done."}
		]`))
	session, err := agent.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	shown := make(chan modular.Question, 1)
	reply := make(chan modular.Answer, 1)
	err = session.OnQuestion(ctx, func(ctx context.Context, q modular.Question) (modular.Answer, error) {
		shown <- q
		select {
		case answer := <-reply:
			return answer, nil
		case <-ctx.Done():
			return modular.Answer{}, ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}

	finished := make(chan error, 1)
	go func() {
		turn, err := session.Prompt(ctx, "Choose a palette.")
		if err == nil {
			results := turn.ToolResults()
			if len(results) != 1 || results[0].Text() != "Selected dark." {
				err = fmt.Errorf("unexpected result: %v", results)
			}
		}
		finished <- err
	}()
	select {
	case q := <-shown:
		if q.Kind != "choice" || !slices.Equal(q.Options, []string{"light", "dark"}) {
			t.Fatalf("unexpected question: %+v", q)
		}
		reply <- modular.Answer{Value: "dark"} // The app's click handler.
	case err := <-finished:
		t.Fatalf("turn ended without a question: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
