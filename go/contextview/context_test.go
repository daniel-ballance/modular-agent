package contextview_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/contextview"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/modelselect"
	"strings"
	"testing"
)

func setup(t *testing.T, limit int, scripts ...fake.Script) (api.API, *fake.Provider, string) {
	h := harness.New()
	p := fake.New(scripts...)
	dir, project := t.TempDir(), t.TempDir()
	for _, plugin := range []api.Plugin{history.Plugin(dir), configuration.Plugin("", api.Settings{Model: "fake", Thinking: "off", MaxSteps: 5, MaxOutput: 100, ContextLimit: limit}), p.Plugin(), modelselect.Plugin(), runtimetest.Plugin(t), contextview.Plugin()} {
		if err := h.Load(plugin); err != nil {
			t.Fatal(err)
		}
	}
	id, err := h.API().New(context.Background(), project)
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
func give(t *testing.T, a api.API, id, text string) api.Outcome {
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
func TestAutomaticCompactionAddsSummaryWithoutDeletingHistory(t *testing.T) {
	runtimetest.Each(t, testAutomaticCompactionAddsSummaryWithoutDeletingHistory)
}
func testAutomaticCompactionAddsSummaryWithoutDeletingHistory(t *testing.T) {
	a, p, id := setup(t, 400, fake.Script{Response: api.Response{Content: api.Text(strings.Repeat("old facts ", 400)), Stop: "finished"}},
		fake.Script{Response: api.Response{Content: api.Text("Earlier facts summarized."), Stop: "finished"}},
		fake.Script{Response: api.Response{Content: api.Text("continued"), Stop: "finished"}})
	if out := give(t, a, id, "old question"); out.Status != "completed" {
		t.Fatal(out)
	}
	if out := give(t, a, id, "new question"); out.Status != "completed" {
		t.Fatal(out)
	}
	snap, _ := a.Snapshot(id)
	summaries, originals := 0, 0
	for _, e := range snap.Entries {
		if e.Kind == "summary" {
			summaries++
			if len(e.Copies) < 2 {
				t.Fatal(e)
			}
		}
		if e.Content.Text() == strings.Repeat("old facts ", 400) {
			originals++
		}
	}
	if summaries != 1 || originals != 1 {
		t.Fatal(summaries, originals)
	}
	req := p.Requests()
	if len(req) != 3 || req[2].Messages[0].Content.Text() != "Earlier facts summarized." {
		t.Fatal(req)
	}
	for _, m := range req[2].Messages {
		if strings.Contains(m.Content.Text(), "old facts ") {
			t.Fatal("compacted content still in view")
		}
	}
}
func TestOverflowCompactsAndRetriesOnce(t *testing.T) {
	runtimetest.Each(t, testOverflowCompactsAndRetriesOnce)
}
func testOverflowCompactsAndRetriesOnce(t *testing.T) {
	a, p, id := setup(t, 8000, fake.Script{Response: api.Response{Content: api.Text("old answer"), Stop: "finished"}},
		fake.Script{Err: &api.ModelError{Kind: "context_too_large", Message: "overflow"}},
		fake.Script{Response: api.Response{Content: api.Text("summary"), Stop: "finished"}},
		fake.Script{Response: api.Response{Content: api.Text("retried"), Stop: "finished"}})
	_ = give(t, a, id, "old")
	out := give(t, a, id, "new")
	if out.Status != "completed" || out.Result.Text() != "retried" || out.Steps != 1 {
		t.Fatal(out)
	}
	if len(p.Requests()) != 4 {
		t.Fatal(len(p.Requests()))
	}
}
func TestManualCompactionAndSummaryFailureKeepRawHistory(t *testing.T) {
	runtimetest.Each(t, testManualCompactionAndSummaryFailureKeepRawHistory)
}
func testManualCompactionAndSummaryFailureKeepRawHistory(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "summary", true: "failure"}[fail], func(t *testing.T) {
			script := fake.Script{Response: api.Response{Content: api.Text("summary"), Stop: "finished"}}
			if fail {
				script = fake.Script{Err: &api.ModelError{Kind: "temporary", Message: "no summary"}}
			}
			a, p, id := setup(t, 8000, script)
			_, _ = a.Record(context.Background(), id, api.Entry{Kind: "input", Visible: true, Content: api.Text("older")})
			_, _ = a.Record(context.Background(), id, api.Entry{Kind: "model", Visible: true, Content: api.Text("older reply")})
			_, _ = a.Record(context.Background(), id, api.Entry{Kind: "input", Visible: true, Content: api.Text("recent")})
			_, err := a.Command(context.Background(), id, "/compact")
			if (err != nil) != fail {
				t.Fatal(err)
			}
			snap, _ := a.Snapshot(id)
			if len(snap.Entries) < 3 || len(p.Requests()) != 1 {
				t.Fatal(snap)
			}
		})
	}
}
