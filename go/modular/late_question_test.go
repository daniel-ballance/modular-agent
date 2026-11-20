package modular_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/OWNER/modular-agent/go/modular"
	"github.com/OWNER/modular-agent/go/modular/modulartest"
)

func TestQuestionHandlerCanAnswerAfterTheTurn(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	release := make(chan struct{})
	tool := modular.NewTool("question", "Ask a question.", func(ctx context.Context, _ struct{}, call *modular.ToolContext) (string, error) {
		answer, err := call.Ask(ctx, modular.Question{Kind: "text", Question: "What value?"}, modular.AskOptions{Wait: 20 * time.Millisecond, Then: "leaveOpen"})
		return "got " + answer.Value, err
	})
	a := modulartest.Agent(t, modular.WithLateAnswersStartTurns(true), modular.WithTool(tool), modulartest.Script(`[{"toolCalls":[{"name":"question","input":{}}]},{"text":"done"}]`), modular.WithOnQuestion(func(ctx context.Context, _ modular.Question) (modular.Answer, error) {
		select {
		case <-release:
			return modular.Answer{Value: "late fixture"}, nil
		case <-ctx.Done():
			return modular.Answer{}, ctx.Err()
		}
	}))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.Prompt(ctx, "Ask.")
	if err != nil || first.Outcome == nil || first.Outcome.Kind != "completed" || len(first.OpenToolCalls) != 1 {
		t.Fatalf("first turn did not leave its question open: %+v, %v", first, err)
	}
	close(release)
	for {
		history, err := s.History(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range history {
			raw, _ := json.Marshal(row["message"])
			if row["kind"] == "toolResult" && strings.Contains(string(raw), "got late fixture") {
				return
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("late answer did not settle the call")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
