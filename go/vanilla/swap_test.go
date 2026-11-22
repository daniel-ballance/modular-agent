package vanilla_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDurableReplacesOnlyRuntimeAndKeepsFeatureHandlers(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "fact"), []byte("swap-fact"), 0600); err != nil {
		t.Fatal(err)
	}
	p := fake.New(fake.Script{Response: api.Response{Stop: "tools", Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "read", Name: "read", Input: api.JSON(map[string]string{"path": "fact"})}}}}}, fake.Script{Require: "swap-fact", Response: api.Response{Stop: "finished", Content: api.Text("read through unchanged plugins")}})
	h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Global: filepath.Join(root, "absent"), Model: "fake", Provider: p.Plugin()})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	plugin := durable.Plugin()
	plugin.Replaces = "transient"
	if err = h.Load(plugin); err != nil {
		t.Fatal(err)
	}
	v, err := h.API().Get("runtime")
	if err != nil {
		t.Fatal(err)
	}
	if d := v.(api.Runtime).Declaration(); !d.Durable || !d.Steering {
		t.Fatal(d)
	}
	id, err := h.API().New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.API().Submit(context.Background(), id, api.Input{Content: api.Text("read fact")})
	if err != nil {
		t.Fatal(err)
	}
	out, err := h.API().Wait(context.Background(), id)
	if err != nil || out.Status != "completed" || out.Result.Text() != "read through unchanged plugins" {
		t.Fatal(out, err)
	}
	// contextview's existing standard hook constructed the full model context.
	if len(p.Requests()) != 2 {
		t.Fatal(p.Requests())
	}
	support, err := h.API().Command(context.Background(), id, "/support")
	if err != nil {
		t.Fatal(err)
	}
	declarations := api.Decode[map[string]bool]([]byte(support))
	// The local environment confirms full cleanup after SIGKILL only on Linux.
	if !declarations["durable_turns"] || declarations["sigkill_command_cleanup"] != (runtime.GOOS == "linux") || !declarations["parallel_tools"] {
		t.Fatal(support)
	}
}
