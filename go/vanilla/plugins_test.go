package vanilla_test

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"testing"
)

func TestToolHooksRewriteInputAndFailuresStillSettleWholeBatch(t *testing.T) {
	runtimetest.Each(t, testToolHooksRewriteInputAndFailuresStillSettleWholeBatch)
}
func testToolHooksRewriteInputAndFailuresStillSettleWholeBatch(t *testing.T) {
	state, project := t.TempDir(), t.TempDir()
	p := fake.New(fake.Script{Response: api.Response{Content: api.Content{
		{Type: "tool_call", Call: &api.Call{ID: "write", Name: "write", Input: api.JSON(map[string]string{"path": "requested.txt", "content": "hello"})}},
		{Type: "tool_call", Call: &api.Call{ID: "read", Name: "read", Input: api.JSON(map[string]string{"path": "actual.txt"})}},
	}, Stop: "tools"}})
	h, err := vanilla.New(vanilla.Options{Runtime: runtimetest.Plugin(t), History: state, Provider: p.Plugin(), Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.Load(api.Plugin{Name: "rewrite", Setup: func(a api.API) error {
		return a.Handle("runtime.tool.before", "first", func(ctx context.Context, v any) (api.Decision, error) {
			check := v.(api.ToolCheck)
			check.Call.Input = api.JSON(map[string]string{"path": "actual.txt", "content": "hello"})
			return api.Decision{Value: check}, nil
		})
	}}); err != nil {
		t.Fatal(err)
	}
	if err = h.Load(api.Plugin{Name: "post-failure", Setup: func(a api.API) error {
		return a.Handle("runtime.tool.after", "", func(context.Context, any) (api.Decision, error) {
			return api.Decision{}, errors.New("post-tool failure")
		})
	}}); err != nil {
		t.Fatal(err)
	}
	a := h.API()
	id, err := a.New(context.Background(), project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Submit(context.Background(), id, api.Input{Content: api.Text("go")}); err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(context.Background(), id)
	if err != nil || out.Status != "failed" {
		t.Fatal(out, err)
	}
	if _, err = os.Stat(filepath.Join(project, "requested.txt")); !os.IsNotExist(err) {
		t.Fatal("original input ran")
	}
	if b, err := os.ReadFile(filepath.Join(project, "actual.txt")); err != nil || string(b) != "hello" {
		t.Fatal("rewritten input did not run", err)
	}
	snap, _ := a.Snapshot(id)
	results := map[string][]string{}
	recordedActual := false
	for _, entry := range snap.Entries {
		if entry.Kind == "tool.result" {
			r := api.Decode[api.ToolResult](entry.Data)
			results[r.Call] = append(results[r.Call], r.Status)
		}
		if entry.Kind == "tool.started" {
			call := api.Decode[api.Call](entry.Data)
			args := api.Decode[map[string]string](call.Input)
			recordedActual = args["path"] == "actual.txt" && call.Actor == "local-user"
		}
	}
	if len(results["write"]) != 1 || results["write"][0] != "completed" || len(results["read"]) != 1 || results["read"][0] != "not_started" || !recordedActual {
		t.Fatal(results, recordedActual)
	}
}
