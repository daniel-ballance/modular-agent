package modular

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/local"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

func TestCompositionAndPluginHost(t *testing.T) {
	ctx := t.Context()
	t.Setenv("MODULAR_AGENT_PLUGINS", `[{"command":["/no/such/plugin"]}]`)
	a, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		opts []Option
	}{
		{"host reads environment", []Option{WithPluginHost(true)}},
		{"explicit processes require host", []Option{WithPluginHost(false), WithProcessPlugin(ProcessPlugin{Command: []string{"/bin/true"}})}},
		{"missing program", []Option{WithProcessPlugin(ProcessPlugin{Command: []string{"/no/such/plugin"}})}},
		{"program exits before registering", []Option{WithProcessPlugin(ProcessPlugin{Command: []string{"/bin/true"}})}},
		{"kept needs data directory", []Option{WithDurability(Kept)}},
		{"durable needs data directory", []Option{WithDurability(Durable)}},
		{"kept cannot use memory", []Option{WithDurability(Kept), WithDataDir(t.TempDir()), WithHistory(MemoryHistory())}},
		{"durable cannot use memory", []Option{WithDurability(Durable), WithDataDir(t.TempDir()), WithHistory(MemoryHistory())}},
		{"kept local bookkeeping needs data directory even with a persistent store", []Option{WithDurability(Kept), WithHistory(FileHistory(t.TempDir()))}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a, err := New(ctx, c.opts...)
			if a != nil {
				defer a.Close(ctx)
			}
			var e *Error
			if !errors.As(err, &e) || e.Code != InvalidComposition {
				t.Fatalf("want invalid_composition, got %v", err)
			}
		})
	}
}

func toolPlugin(only bool) Plugin {
	return Plugin{Name: "refusing", Setup: func(r *Registrar) error {
		opts := []ToolOption{}
		if only {
			opts = append(opts, InProcessOnly())
		}
		return r.Tool(NewTool("refusing", "Refuse with a reason.", func(_ context.Context, _ struct{}, tc *ToolContext) (string, error) {
			return "", tc.Refuse("this is the reason")
		}, opts...))
	}}
}

func TestServedRefusalAndFlag(t *testing.T) {
	for _, only := range []bool{false, true} {
		t.Run(map[bool]string{false: "wording", true: "inProcessOnly"}[only], func(t *testing.T) {
			ctx := t.Context()
			plugin := toolPlugin(only)
			in, clientOut := io.Pipe()
			clientIn, out := io.Pipe()
			finished := make(chan error, 1)
			go func() { finished <- serve(ctx, plugin, in, out); _ = out.Close() }()
			client := pluginrpc.NewPeer(clientIn, clientOut)
			go func() { _ = client.Run() }()
			t.Cleanup(func() { client.Close(); _ = clientOut.Close(); <-finished })
			home := t.TempDir()
			var reg pluginrpc.Registration
			err := client.Call(ctx, "plugin/initialize", map[string]any{"binding": pluginrpc.Binding, "project": home, "home": home, "config": map[string]any{}}, &reg)
			if only {
				if pluginrpc.Code(err) != "not_supported" {
					t.Fatalf("want not_supported, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var wire json.RawMessage
			params := map[string]any{"toolSource": reg.ToolSources[0].ID, "sessionId": "session", "call": map[string]any{"id": "call", "name": "refusing", "input": map[string]any{}, "startedBy": "model", "actorId": "user"}}
			if err := client.Call(ctx, "tools/call", params, &wire); err != nil {
				t.Fatal(err)
			}
			var remote ToolResult
			if err := json.Unmarshal(wire, &remote); err != nil {
				t.Fatal(err)
			}
			r, _ := register(plugin, nil)
			local := (&toolSource{tools: r.tools}).Run(ctx, api.Session{ID: "session"}, api.Call{ID: "call", Name: "refusing", Input: json.RawMessage(`{}`)}, func(string) {})
			if remote.Status != Refused || remote.Text() != local.Content.Text() {
				t.Fatalf("served %#v; local %#v", remote, local)
			}
		})
	}
}

func TestLocalFileDeclaration(t *testing.T) {
	project, other := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "private"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(project, "escape")); err != nil {
		t.Fatal(err)
	}
	a, err := New(t.Context(), WithProject(project))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	env, _ := a.a.Get("working-environment")
	if data, err := env.(api.WorkingEnvironment).Read(t.Context(), project, "escape/private"); err != nil || string(data) != "outside" {
		t.Fatalf("default local environment read %q: %v", data, err)
	}
	if a.Declaration()["confinesFiles"] != false {
		t.Fatalf("default local environment claimed confinement: %v", a.Declaration())
	}
	if _, err := New(t.Context(), WithEnvironment(local.NewAt(t.TempDir()))); err == nil {
		t.Fatal("explicit bookkeeping environment accepted without dataDir")
	}
}
