package subscription_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

// Run by hand before release. The offline suite never signs in or contacts a model.
func TestLiveSubscriptions(t *testing.T) {
	if os.Getenv("MODULAR_AGENT_LIVE") != "1" {
		t.Skip("set MODULAR_AGENT_LIVE=1 to opt in")
	}
	path := os.Getenv("MODULAR_AGENT_LIVE_LOGINS")
	if path == "" {
		t.Skip("set MODULAR_AGENT_LIVE_LOGINS to opt in")
	}
	for _, id := range []string{"chatgpt", "grok", "claude"} {
		t.Run(id, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
			defer cancel()
			var provider modular.Provider
			var model string
			switch id {
			case "chatgpt", "grok":
				logins := subscription.SubscriptionLogins(path)
				l, err := logins.Login(id)
				if err != nil {
					t.Fatal(err)
				}
				if l == nil || l.Type != "oauth" {
					t.Skipf("no %s plan login", id)
				}
				if id == "grok" {
					provider, err = subscription.Grok(subscription.GrokOptions{Logins: logins})
					model = "grok-4.7"
				} else {
					provider, err = subscription.ChatGPT(subscription.ChatGPTOptions{Logins: logins})
					model = "gpt-6.1-sol"
				}
				if err != nil {
					t.Fatal(err)
				}
				if override := os.Getenv("MODULAR_AGENT_LIVE_" + strings.ToUpper(id) + "_MODEL"); override != "" {
					model = override
				}
			case "claude":
				if _, err := subscription.FindClaudeProgram(subscription.ClaudeOptions{}); err != nil {
					t.Skip("Claude program is not installed")
				}
				c, err := subscription.Claude(ctx, subscription.ClaudeOptions{})
				if err != nil {
					t.Fatal(err)
				}
				defer c.Close()
				if ready, reason := c.Status(ctx); !ready {
					t.Skip(reason)
				}
				provider = c.Provider()
				model = os.Getenv("MODULAR_AGENT_LIVE_CLAUDE_MODEL")
				if model == "" {
					model = "claude-haiku-5-5"
				}
			}
			a, err := modular.New(ctx, modular.WithProject(t.TempDir()), modular.WithProvider(provider), modular.WithModel(id+"/"+model))
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(context.Background())
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var streamed strings.Builder
			for event, err := range s.PromptStream(ctx, "Reply with a short greeting.") {
				if err != nil {
					t.Fatal(err)
				}
				if text, ok := event.(modular.TextEvent); ok {
					streamed.WriteString(text.Delta)
				}
			}
			out, err := s.LastTurn(ctx)
			if err != nil || out == nil || out.Outcome == nil || out.Outcome.Kind != "completed" || strings.TrimSpace(out.Text) == "" || streamed.String() != out.Text {
				t.Fatal("subscription request did not complete with matching streamed text", err)
			}
		})
	}
}
