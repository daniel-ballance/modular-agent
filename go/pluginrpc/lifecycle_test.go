package pluginrpc_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRefusedPluginStopsStartup(t *testing.T) {
	for _, tc := range []struct {
		mode, want string
		withFirst  bool
	}{
		{"duplicate-tool", "duplicate plugin name", true},
		{"unsupported", "not_supported", false},
		{"invalid-replace", "replacement was not registered", false},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "shutdown.json")
			refused := childSpec(tc.mode, "")
			refused["env"].(map[string]string)["GO_PLUGIN_SHUTDOWN"] = file
			specs := []any{}
			if tc.withFirst {
				specs = append(specs, childSpec("probe", ""))
			}
			specs = append(specs, refused, childSpec("conformance", "provider"))
			t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON(specs)))
			h, err := vanilla.New(options(t))
			if h != nil || err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatal("startup did not fail", err)
			}
			raw, err := os.ReadFile(file)
			params := api.Decode[map[string]string](raw)
			if err != nil || params["reason"] != "refused" || !strings.Contains(params["detail"], tc.want) {
				t.Fatal(params, err)
			}
		})
	}
}

func TestSecondExternalProviderCannotReplaceFirst(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "provider"), childSpec("conformance", "provider")})))
	h, err := vanilla.New(options(t))
	if h != nil || err == nil || !strings.Contains(err.Error(), "duplicate plugin name") {
		t.Fatal("duplicate provider did not fail startup", err)
	}
}

func TestExternalProviderCanBeTheOnlyProvider(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "provider")})))
	opt := options(t)
	opt.Provider = api.Plugin{}
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if len(h.API().All("provider.")) != 1 {
		t.Fatal("external-only provider was not composed")
	}
}

func TestExplicitToolCallersAreEnforced(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("callers", "")})))
	opt := options(t)
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	a := h.API()
	id, err := a.New(context.Background(), opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	runtimetest.Publish(t, a, id)
	result, err := a.CallTool(context.Background(), id, api.Call{Name: "ui-only", Input: api.JSON(map[string]any{})})
	if err != nil || result.Status != "completed" || result.Content.Text() != "UI called it" {
		t.Fatal(result, err)
	}
	_, err = a.Submit(context.Background(), id, api.Input{Content: api.Text(`tool:ui-only {}`)})
	if err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(context.Background(), id)
	if err != nil || out.Status != "failed" || !strings.Contains(out.Error, "Invalid tool directive") {
		t.Fatal(out, err)
	}
	snap, err := a.Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range snap.Entries {
		if e.Kind == "model.request" && e.OfferedTools != nil {
			for _, name := range *e.OfferedTools {
				if name == "ui-only" {
					t.Fatal("UI-only tool was offered to the model")
				}
			}
		}
	}
}

func TestWeakerExternalEnvironmentDoesNotPromiseCrashSafeRecovery(t *testing.T) {
	ended := filepath.Join(t.TempDir(), "ended.json")
	spec := childSpec("environment", "")
	spec["env"].(map[string]string)["GO_PLUGIN_SESSION_ENDED"] = ended
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{spec})))
	opt := options(t)
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	env, err := h.API().Get("working-environment")
	if err != nil || env.(api.WorkingEnvironment).StopsOnCrash() {
		t.Fatal("weak containment must not promise safe repetition", env, err)
	}
	id, err := h.API().New(context.Background(), opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.API().CloseSession(id); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(ended)
	if err != nil || api.Decode[map[string]string](raw)["sessionId"] != id {
		t.Fatalf("session end was not sent: %s %v", raw, err)
	}
}
