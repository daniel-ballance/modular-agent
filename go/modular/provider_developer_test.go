package modular_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type fixtureCredentials struct{}

func (fixtureCredentials) Get(context.Context, string) (string, error) {
	return "fixture-provider-credential", nil
}

func TestDeveloperProviderPlacements(t *testing.T) {
	for _, place := range []string{"embedded", "served"} {
		t.Run(place, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			var changed modular.CatalogChanges
			var ready, updated atomic.Bool
			var requests atomic.Int32
			p := modular.Provider{ID: "developer", CatalogChanges: &changed, Available: ready.Load, Models: func() []modular.ModelInfo {
				name := "one"
				if updated.Load() {
					name = "two"
				}
				return []modular.ModelInfo{{ModelRef: modular.ModelRef{Provider: "developer", ID: name}, ContextWindow: 8192, MaxOutput: 1024, Input: []string{"text"}}}
			}, Request: func(ctx context.Context, m modular.ModelRef, r modular.ModelRequest, c *modular.ProviderContext) (modular.AssistantMessage, error) {
				requests.Add(1)
				if key, err := c.Credential(); err != nil || key != "fixture-provider-credential" {
					t.Error("Provider did not receive the configured host credential")
				}
				if m.ID != "two" {
					t.Errorf("wrong current model: %v", m)
				}
				if r.SessionID == "" {
					t.Error("missing session scope")
				}
				c.Piece("text", "Hello.")
				return modular.AssistantMessage{Content: modular.Text("Hello."), Stop: "finished"}, nil
			}}
			opt := modular.WithProvider(p)
			if place == "served" {
				opt = modulartest.OverWire(modular.Plugin{Name: "developer", Setup: func(r *modular.Registrar) error { return r.Provider(p) }})
			}
			a, err := modular.New(ctx, opt, modular.WithProject(t.TempDir()), modular.WithCredentials(fixtureCredentials{}))
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(context.Background())
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			turn, err := s.Prompt(ctx, "Test readiness")
			if err != nil || turn.Outcome == nil || turn.Outcome.Kind != "failed" || requests.Load() != 0 {
				t.Fatalf("unavailable Provider was not refused: %+v, %v", turn, err)
			}
			updated.Store(true)
			changed.Changed()
			ready.Store(true)
			if ms := a.Models(); len(ms) != 1 || ms[0].ID != "two" {
				t.Fatalf("stale catalog: %v", ms)
			}
			if err = s.SetSetting(ctx, "model", "developer/two"); err != nil {
				t.Fatal(err)
			}
			text := ""
			for event, err := range s.PromptStream(ctx, "Test current catalog and credentials") {
				if err != nil {
					t.Fatal(err)
				}
				if x, ok := event.(modular.TextEvent); ok {
					text += x.Delta
				}
			}
			if text != "Hello." || requests.Load() != 1 {
				t.Fatalf("unexpected Provider settlement: %q, %d requests", text, requests.Load())
			}
		})
	}
}
