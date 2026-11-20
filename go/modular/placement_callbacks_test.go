package modular_test

import (
	"context"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestToolHistoryAndEmitPlacements(t *testing.T) {
	for _, place := range []string{"inProcess", "served"} {
		t.Run(place, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			contexts := make(chan *modular.ToolContext, 1)
			tool := modular.NewTool("inspect", "Inspect the plugin's session.", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
				contexts <- tc
				page, err := tc.History(ctx)
				if err != nil {
					return "", err
				}
				for _, e := range page.Entries {
					if e["kind"] == "input" {
						return "found input", tc.Emit(ctx, "inspect.checked", "input")
					}
				}
				return "no input", nil
			})
			plugin := modular.Plugin{Name: "inspector", Setup: func(r *modular.Registrar) error { return r.Tool(tool) }}
			option := modular.WithPlugin(plugin)
			if place == "served" {
				option = modulartest.OverWire(plugin)
			}
			a := modulartest.Agent(t, option, modulartest.Script(`[{"toolCalls":[{"name":"inspect","input":{}}]},{"text":"Done."}]`))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			events := make(chan string, 1)
			ready := make(chan struct{})
			go func() {
				first := true
				for e, err := range s.Events(ctx) {
					if first {
						close(ready)
						first = false
					}
					if err != nil {
						events <- err.Error()
						return
					}
					if data, ok := e.(modular.DataEvent); ok && data.Type == "plugin.inspector.inspect.checked" {
						events <- string(data.Data)
						return
					}
				}
			}()
			select {
			case <-ready:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			turn, err := s.Prompt(ctx, "Inspect this input.")
			if err != nil {
				t.Fatal(err)
			}
			if results := turn.ToolResults(); len(results) != 1 || results[0].Text() != "found input" {
				t.Fatalf("tool result: %+v", results)
			}
			tc := <-contexts
			_, err = tc.History(ctx)
			requireCode(t, err, modular.InvalidRequest)
			requireCode(t, tc.Emit(ctx, "inspect.checked", nil), modular.InvalidRequest)
			select {
			case event := <-events:
				if event != `"input"` {
					t.Fatalf("custom event: %s", event)
				}
			case <-ctx.Done():
				t.Fatal("no custom event")
			}
		})
	}
}

func TestSDKRuntimeComposition(t *testing.T) {
	ctx := t.Context()
	_, err := modular.New(ctx, modular.WithRuntime(modular.DurableRuntime()), modular.WithDurability(modular.Durable), modular.WithDataDir(t.TempDir()), modular.WithHistory(modular.MemoryHistory()))
	requireCode(t, err, modular.InvalidComposition)
	_, err = modular.New(ctx, modular.WithRuntime(modular.DurableRuntime()))
	requireCode(t, err, modular.InvalidComposition)
	_, err = modular.New(ctx, modular.WithDurability(modular.Durable), modular.WithDataDir(t.TempDir()), modular.WithRuntime(modular.TransientRuntime()))
	requireCode(t, err, modular.InvalidComposition)
	for _, placement := range []string{"inProcess", "served"} {
		t.Run(placement, func(t *testing.T) {
			p := modular.Plugin{Name: "alternate-runtime", Replaces: []string{"runtime"}, Setup: func(r *modular.Registrar) error { return r.Runtime(modular.TransientRuntime()) }}
			opt := modular.WithPlugin(p)
			if placement == "served" {
				opt = modulartest.OverWire(p)
			}
			a := modulartest.Agent(t, opt, modulartest.Script(`[{"text":"Hello."}]`))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			turn, err := s.Prompt(ctx, "Say hello.")
			if err != nil || turn.Text != "Hello." {
				t.Fatalf("turn %v, %v", turn, err)
			}
		})
	}
}
