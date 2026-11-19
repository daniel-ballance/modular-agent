package harness_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/contextview"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/history"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/modelselect"
	"strings"
	"testing"
)

func TestGateCannotSkipLaterRefusal(t *testing.T) {
	h := harness.New()
	var owner api.API
	_ = h.Load(api.Plugin{Name: "owner", Setup: func(a api.API) error { owner = a; return a.Define("point", api.Gate) }})
	_ = h.Load(api.Plugin{Name: "allow", Setup: func(a api.API) error {
		return a.Handle("point", "", func(context.Context, any) (api.Decision, error) {
			return api.Decision{Value: "changed", Stop: true}, nil
		})
	}})
	_ = h.Load(api.Plugin{Name: "refuse", Setup: func(a api.API) error {
		return a.Handle("point", "", func(_ context.Context, v any) (api.Decision, error) {
			if v != "changed" {
				t.Error("change was not propagated")
			}
			return api.Decision{Refuse: true}, nil
		})
	}})
	if _, err := owner.Invoke(context.Background(), "point", "initial"); err == nil {
		t.Fatal("early allow skipped later refusal")
	}
}
func TestReplacementPreservesOtherPluginsHandlersForSameHook(t *testing.T) {
	h := harness.New()
	var owner api.API
	_ = h.Load(api.Plugin{Name: "old", Setup: func(a api.API) error { return a.Define("stable", api.Transform) }})
	_ = h.Load(api.Plugin{Name: "feature", Setup: func(a api.API) error {
		return a.Handle("stable", "", func(context.Context, any) (api.Decision, error) { return api.Decision{Value: "feature remains"}, nil })
	}})
	if err := h.Load(api.Plugin{Name: "new", Replaces: "old", Setup: func(a api.API) error { owner = a; return a.Define("stable", api.Transform) }}); err != nil {
		t.Fatal(err)
	}
	got, err := owner.Invoke(context.Background(), "stable", "initial")
	if err != nil || got != "feature remains" {
		t.Fatal(got, err)
	}
}
func TestErasingTakenInputRemovesIntakeCopiesAndCachedOutcome(t *testing.T) {
	runtimetest.Each(t, testErasingTakenInputRemovesIntakeCopiesAndCachedOutcome)
}
func testErasingTakenInputRemovesIntakeCopiesAndCachedOutcome(t *testing.T) {
	h := harness.New()
	dir, project := t.TempDir(), t.TempDir()
	defer h.Close()
	p := fake.New(fake.Script{Response: api.Response{Content: api.Text("copied private-phrase"), Stop: "finished"}})
	for _, plugin := range []api.Plugin{history.Plugin(dir), configuration.Plugin("", api.Settings{Model: "fake", Thinking: "off", MaxSteps: 3, MaxOutput: 100}), p.Plugin(), modelselect.Plugin(), runtimetest.Plugin(t), contextview.Plugin()} {
		if err := h.Load(plugin); err != nil {
			t.Fatal(err)
		}
	}
	a := h.API()
	id, _ := a.New(context.Background(), project)
	_, err := a.Submit(context.Background(), id, api.Input{Content: api.Text("private-phrase")})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = a.Wait(context.Background(), id)
	snap, _ := a.Snapshot(id)
	source := ""
	for _, e := range snap.Entries {
		if e.Kind == "input" {
			source = e.ID
		}
	}
	if err = a.Erase(context.Background(), id, []string{source}); err != nil {
		t.Fatal(err)
	}
	snap, _ = a.Snapshot(id)
	if strings.Contains(string(api.JSON(snap)), "private-phrase") {
		t.Fatal("intake copy survived erasure")
	}
	out, err := a.Wait(context.Background(), id)
	if err != nil || strings.Contains(string(api.JSON(out)), "private-phrase") {
		t.Fatal("outcome cache survived erasure", out, err)
	}
}
