package modular_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/anthropic"
	"github.com/daniel-ballance/modular-agent/go/modular/internal/fixtures"
	"github.com/daniel-ballance/modular-agent/go/modular/openai"
)

// Run by hand before a release; never enable this in the offline suite.
func TestLiveProviders(t *testing.T) {
	if os.Getenv("MODULAR_AGENT_LIVE") != "1" {
		t.Skip("set MODULAR_AGENT_LIVE=1 to opt in")
	}
	for _, test := range []struct {
		id, key, selector, fallback string
		provider                    func(string) modular.Provider
	}{
		{"openai", "OPENAI_API_KEY", "MODULAR_AGENT_LIVE_OPENAI_MODEL", "gpt-6-luna", func(id string) modular.Provider { return openai.New(openai.WithModel(id)) }},
		{"anthropic", "ANTHROPIC_API_KEY", "MODULAR_AGENT_LIVE_ANTHROPIC_MODEL", "claude-haiku-5-5", func(id string) modular.Provider { return anthropic.New(anthropic.WithModel(id)) }},
	} {
		t.Run(test.id, func(t *testing.T) {
			if os.Getenv(test.key) == "" {
				t.Skip("missing " + test.key)
			}
			model := os.Getenv(test.selector)
			if model == "" {
				model = test.fallback
			}
			ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
			defer cancel()
			tide, err := fixtures.Plugin("tide")
			if err != nil {
				t.Fatal(err)
			}
			a, err := modular.New(ctx, modular.WithProject(t.TempDir()), modular.WithProvider(test.provider(model)), modular.WithPlugin(tide), modular.WithModel(test.id+"/"+model), modular.WithSettings(modular.Settings{"maxOutput": 768}))
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(context.Background())
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var chunks strings.Builder
			for event, e := range s.PromptStream(ctx, "Reply with a short greeting. Do not use a tool.") {
				if e != nil {
					t.Fatal(e)
				}
				if text, ok := event.(modular.TextEvent); ok {
					chunks.WriteString(text.Delta)
				}
			}
			turn, err := s.LastTurn(ctx)
			if err != nil || turn == nil || turn.Outcome == nil || turn.Outcome.Kind != "completed" || strings.TrimSpace(turn.Text) == "" || chunks.String() != turn.Text {
				t.Fatalf("text stream and completed turn disagree: %v", err)
			}
			turn2, err := s.Prompt(ctx, "Use the tide tool now to look up Whitby, then report its exact time.")
			if err != nil {
				t.Fatal(err)
			}
			results := turn2.ToolResults()
			if turn2.Outcome == nil || turn2.Outcome.Kind != "completed" || len(results) != 1 || results[0].Name != "tide" || results[0].Status != modular.Completed || !strings.Contains(turn2.Text, "14:02") {
				t.Fatal("model did not report the tide tool result")
			}
			level := ""
			for _, candidate := range a.Models()[0].Thinking {
				if candidate != "off" {
					level = candidate
					break
				}
			}
			if level == "" {
				t.Fatal("no active reasoning level in the catalog")
			}
			if err = s.SetSetting(ctx, "reasoning", level); err != nil {
				t.Fatal(err)
			}
			final, err := s.Prompt(ctx, "What is 8 + 9? Answer briefly without calling a tool.")
			if err != nil || final.Outcome == nil || final.Outcome.Kind != "completed" || strings.TrimSpace(final.Text) == "" {
				t.Fatalf("reasoning prompt did not complete: %v", err)
			}
		})
	}
}
