package configuration_test

import (
	"context"
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"testing"
)

func put(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestConfiguredPluginsTrustAndOptions(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, trusted := range []bool{false, true} {
			t.Run(map[bool]string{false: "untrusted", true: "trusted"}[trusted], func(t *testing.T) {
				root := t.TempDir()
				global := filepath.Join(t.TempDir(), "settings.json")
				put(t, global, `{"plugins":[{"name":"probe","options":{"label":"global","keep":7}}]}`)
				put(t, filepath.Join(root, ".modular-agent", "settings.json"), `{"model":"fake","thinking":"off","plugins":[{"name":"probe","options":{"label":"project"}},{"name":"project-only","options":{}}]}`)
				loaded := map[string]map[string]any{}
				factory := func(name string) configuration.Factory {
					return func(b json.RawMessage) (api.Plugin, error) {
						var opt map[string]any
						if e := json.Unmarshal(b, &opt); e != nil {
							return api.Plugin{}, e
						}
						loaded[name] = opt
						return api.Plugin{Name: name, Setup: func(a api.API) error {
							return a.RegisterCommand(name, func(context.Context, string, []string) (string, error) { return opt["label"].(string), nil })
						}}, nil
					}
				}
				h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Global: global, Project: root, TrustProject: trusted, Provider: fake.New().Plugin(), Model: "not-default", Runtime: runtimetest.Plugin(t), Factories: map[string]configuration.Factory{"probe": factory("probe"), "project-only": factory("project-only")}})
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				id, err := h.API().New(context.Background(), root)
				if err != nil {
					t.Fatal(err)
				}
				snap, _ := h.API().Snapshot(id)
				if snap.Settings.Model != "fake" {
					t.Fatal("untrusted session defaults did not apply", snap.Settings)
				}
				expected := "global"
				if trusted {
					expected = "project"
				}
				if loaded["probe"]["label"] != expected || loaded["probe"]["keep"] != float64(7) {
					t.Fatal(loaded)
				}
				if _, ok := loaded["project-only"]; ok != trusted {
					t.Fatal(loaded)
				}
				result, err := h.API().Command(context.Background(), id, "probe")
				if err != nil || result != expected {
					t.Fatal(result, err)
				}
				if _, err = h.API().New(context.Background(), t.TempDir()); err == nil {
					t.Fatal("project registrations leaked")
				}
			})
		}
	})
}
func TestUntrustedPluginDataIsNotDecoded(t *testing.T) {
	root := t.TempDir()
	put(t, filepath.Join(root, ".modular-agent", "settings.json"), `{"model":"fake","plugins":"not executable configuration"}`)
	list, err := configuration.Plugins("", root, false)
	if err != nil || len(list) != 0 {
		t.Fatal(list, err)
	}
	if _, err = configuration.Plugins("", root, true); err == nil {
		t.Fatal("trusted malformed plugins accepted")
	}
}
func TestConfiguredPluginFailuresAndGuardrail(t *testing.T) {
	runtimetest.Each(t, testConfiguredPluginFailuresAndGuardrail)
}
func testConfiguredPluginFailuresAndGuardrail(t *testing.T) {
	for _, body := range []string{`{"plugins":[{"name":"unknown"}]}`, `{"plugins":[{"name":"guardrail"},{"name":"guardrail"}]}`, `{"plugins":[{"name":"guardrail","options":{"secrets":42}}]}`} {
		global := filepath.Join(t.TempDir(), "settings.json")
		put(t, global, body)
		h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Global: global, Provider: fake.New().Plugin(), Model: "fake"})
		if err == nil {
			h.Close()
			t.Fatal("bad plugin settings accepted", body)
		}
	}
	global := filepath.Join(t.TempDir(), "settings.json")
	put(t, global, `{"plugins":[{"name":"guardrail","options":{"secrets":["cobalt"]}}]}`)
	h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Global: global, Provider: fake.New(fake.Script{Response: api.Response{Content: api.Text("cobalt"), Stop: "finished"}}).Plugin(), Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	id, err := h.API().New(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h.API().Submit(context.Background(), id, api.Input{Content: api.Text("hello")})
	out, err := h.API().Wait(context.Background(), id)
	if err != nil || out.Result.Text() == "cobalt" {
		t.Fatal(out, err)
	}
}
