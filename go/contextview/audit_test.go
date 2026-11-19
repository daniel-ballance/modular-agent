package contextview_test

import (
	"context"
	"modular/api"
	"modular/contextview"
	"modular/fake"
	"modular/internal/runtimetest"
	"strings"
	"testing"
)

func TestForkPreservesCompactedModelView(t *testing.T) {
	runtimetest.Each(t, testForkPreservesCompactedModelView)
}
func testForkPreservesCompactedModelView(t *testing.T) {
	a, _, id := setup(t, 8000, fake.Script{Response: api.Response{Content: api.Text("summary"), Stop: "finished"}})
	for _, entry := range []api.Entry{{Kind: "input", Visible: true, Content: api.Text("old question")}, {Kind: "model", Visible: true, Content: api.Text("old reply")}, {Kind: "input", Visible: true, Content: api.Text("recent")}} {
		if _, err := a.Record(context.Background(), id, entry); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.Command(context.Background(), id, "/compact"); err != nil {
		t.Fatal(err)
	}
	fork, err := a.Fork(context.Background(), id, "")
	if err != nil {
		t.Fatal(err)
	}
	snap, _ := a.Snapshot(fork)
	messages, _ := contextview.Messages(snap.Branch())
	if len(messages) != 2 || messages[0].Content.Text() != "summary" || messages[1].Content.Text() != "recent" {
		t.Fatal(messages)
	}
}
func TestRepeatedOverflowStopsAfterSingleCompactionRetry(t *testing.T) {
	runtimetest.Each(t, testRepeatedOverflowStopsAfterSingleCompactionRetry)
}
func testRepeatedOverflowStopsAfterSingleCompactionRetry(t *testing.T) {
	a, p, id := setup(t, 8000,
		fake.Script{Response: api.Response{Content: api.Text("old reply"), Stop: "finished"}},
		fake.Script{Err: &api.ModelError{Kind: "context_too_large", Message: "overflow"}},
		fake.Script{Response: api.Response{Content: api.Text("summary"), Stop: "finished"}},
		fake.Script{Err: &api.ModelError{Kind: "context_too_large", Message: "overflow"}})
	_ = give(t, a, id, "old question")
	out := give(t, a, id, "new question")
	if out.Status != "failed" || !strings.Contains(out.Error, "context_too_large") || len(p.Requests()) != 4 {
		t.Fatal(out, len(p.Requests()))
	}
}
