package transient_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/contextview"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/history"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/local"
	"github.com/OWNER/modular-agent/go/modelselect"
	"github.com/OWNER/modular-agent/go/tools"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setup(t *testing.T, scripts ...fake.Script) (api.API, *fake.Provider, string) {
	t.Helper()
	h := harness.New()
	p := fake.New(scripts...)
	for _, plugin := range []api.Plugin{history.Plugin(t.TempDir()), configuration.Plugin("", api.Settings{Model: "fake", Thinking: "off", MaxSteps: 5, MaxOutput: 100}), p.Plugin(), modelselect.Plugin(), local.Plugin(), tools.Plugin(), runtimetest.Plugin(t), contextview.Plugin()} {
		if err := h.Load(plugin); err != nil {
			t.Fatal(err)
		}
	}
	id, err := h.API().New(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})
	return h.API(), p, id
}
func run(t *testing.T, a api.API, id, text string) api.Outcome {
	t.Helper()
	if _, err := a.Submit(context.Background(), id, api.Input{Content: api.Text(text)}); err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestReadFileThenAnswerWithExactlyOneResult(t *testing.T) {
	runtimetest.Each(t, testReadFileThenAnswerWithExactlyOneResult)
}
func testReadFileThenAnswerWithExactlyOneResult(t *testing.T) {
	a, p, id := setup(t, fake.Script{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "read-call", Name: "read", Input: api.JSON(map[string]string{"path": "fact.txt"})}}}, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("The answer is 42."), Stop: "finished", Usage: api.Usage{Input: 7, Output: 4}}})
	snap, _ := a.Snapshot(id)
	if err := os.WriteFile(filepath.Join(snap.Project, "fact.txt"), []byte("42"), 0600); err != nil {
		t.Fatal(err)
	}
	out := run(t, a, id, "Read fact.txt")
	if out.Status != "completed" || out.Steps != 2 || out.Result.Text() != "The answer is 42." || out.Usage.Input != 7 {
		t.Fatal(out)
	}
	requests := p.Requests()
	if len(requests) != 2 {
		t.Fatal(requests)
	}
	found := false
	for _, m := range requests[1].Messages {
		if m.Result != nil && m.Result.Content.Text() == "42" {
			found = true
		}
	}
	if !found {
		t.Fatal("model never received tool result")
	}
	snap, _ = a.Snapshot(id)
	calls, results := 0, 0
	for _, e := range snap.Entries {
		if e.Kind == "tool.call" {
			calls++
		}
		if e.Kind == "tool.result" {
			results++
		}
		if e.Turn != "" && (e.Actor == "" || e.Writer == "") {
			t.Fatal("unattributed record", e)
		}
	}
	if calls != 1 || results != 1 {
		t.Fatal(calls, results)
	}
}
func TestLimitAndModelFailureOutcomes(t *testing.T) {
	runtimetest.Each(t, testLimitAndModelFailureOutcomes)
}
func testLimitAndModelFailureOutcomes(t *testing.T) {
	for _, kind := range []string{"limit", "failure"} {
		t.Run(kind, func(t *testing.T) {
			script := fake.Script{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "call", Name: "read", Input: api.JSON(map[string]string{"path": "missing"})}}}, Stop: "tools"}}
			if kind == "failure" {
				script = fake.Script{Err: &api.ModelError{Kind: "temporary", Message: "offline failure"}}
			}
			a, _, id := setup(t, script)
			s, _ := a.Snapshot(id)
			s.Settings.MaxSteps = 1
			if err := a.SetSettings(context.Background(), id, s.Settings); err != nil {
				t.Fatal(err)
			}
			out := run(t, a, id, "go")
			want := "limit"
			if kind == "failure" {
				want = "failed"
			}
			if out.Status != want {
				t.Fatal(out)
			}
		})
	}
}
func TestInvalidToolAndHookFailureStillProduceResults(t *testing.T) {
	runtimetest.Each(t, testInvalidToolAndHookFailureStillProduceResults)
}
func testInvalidToolAndHookFailureStillProduceResults(t *testing.T) {
	a, _, id := setup(t, fake.Script{Response: api.Response{Content: api.Content{
		{Type: "tool_call", Call: &api.Call{ID: "bad-input", Name: "read", Input: api.JSON(map[string]int{"path": 9})}},
		{Type: "tool_call", Call: &api.Call{ID: "unknown", Name: "does-not-exist", Input: api.JSON(map[string]string{})}},
	}, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("handled"), Stop: "finished"}})
	out := run(t, a, id, "go")
	if out.Status != "completed" {
		t.Fatal(out)
	}
	snap, _ := a.Snapshot(id)
	count := 0
	for _, e := range snap.Entries {
		if e.Kind == "tool.result" {
			r := api.Decode[api.ToolResult](e.Data)
			if r.Status != "failed" || !strings.Contains(r.Content.Text(), "") {
				t.Fatal(r)
			}
			count++
		}
	}
	if count != 2 {
		t.Fatal(count)
	}
}
