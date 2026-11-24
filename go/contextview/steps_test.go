package contextview_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/contextview"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"testing"
)

func TestCompactionKeepsOpenCallForItsLateResult(t *testing.T) {
	a, _, id := setup(t, 8000, fake.Script{Response: api.Response{Content: api.Text("Summary."), Stop: "finished"}})
	call := api.Call{ID: "pending", Name: "read", Input: api.JSON(map[string]string{"path": "file"})}
	record := func(e api.Entry) {
		t.Helper()
		if _, err := a.Record(t.Context(), id, e); err != nil {
			t.Fatal(err)
		}
	}
	record(api.Entry{Kind: "input", Visible: true, Content: api.Text("Original input")})
	record(api.Entry{Kind: "model", Turn: "origin", Step: "step", Visible: true,
		Data: api.JSON(api.Response{Stop: "tools"}), Content: api.Content{{Type: "tool_call", Call: &call}}})
	record(api.Entry{Kind: "turn.end", Turn: "origin", Data: api.JSON(api.Outcome{Status: "completed", Open: []api.Call{call}})})
	record(api.Entry{Kind: "input", Visible: true, Content: api.Text("Newer input")})
	if _, err := a.Command(t.Context(), id, "/compact"); err != nil {
		t.Fatal(err)
	}
	result := api.ToolResult{Call: call.ID, Name: call.Name, Status: "refused", Content: api.Text("Declined.")}
	record(api.Entry{Kind: "tool.result", Turn: "origin", Step: "step", Call: call.ID, Visible: true, Content: result.Content, Data: api.JSON(result)})
	snap, err := a.Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	m, _ := contextview.Messages(snap.Branch())
	if len(m) != 4 || m[0].Content.Text() != "Summary." || m[1].Role != "assistant" ||
		m[2].Result == nil || m[2].Result.Call != call.ID || m[2].Result.Content.Text() != "Declined." ||
		m[3].Content.Text() != "Newer input" {
		t.Fatalf("compaction split an open call from its late result: %+v", m)
	}
}

func TestCompactionCanSummarizeEarlierStepsInsideOneTurn(t *testing.T) {
	runtimetest.Each(t, testCompactionCanSummarizeEarlierStepsInsideOneTurn)
}
func testCompactionCanSummarizeEarlierStepsInsideOneTurn(t *testing.T) {
	a, _, id := setup(t, 8000, fake.Script{Response: api.Response{Content: api.Text("Earlier tool facts and task summarized."), Stop: "finished"}})
	entries := []api.Entry{{Kind: "input", Visible: true, Content: api.Text("one task")}}
	for _, name := range []string{"older-call", "recent-call"} {
		entries = append(entries, api.Entry{Kind: "model", Visible: true, Data: api.JSON(api.Response{Stop: "tools"}), Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: name, Name: "read", Input: api.JSON(map[string]string{"path": "file"})}}}})
		result := api.ToolResult{Call: name, Status: "completed", Content: api.Text(name + " result")}
		entries = append(entries, api.Entry{Kind: "tool.result", Call: name, Visible: true, Content: result.Content, Data: api.JSON(result)})
	}
	for _, entry := range entries {
		if _, err := a.Record(context.Background(), id, entry); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.Command(context.Background(), id, "/compact"); err != nil {
		t.Fatal(err)
	}
	snap, _ := a.Snapshot(id)
	messages, _ := contextview.Messages(snap.Branch())
	if len(messages) != 3 || messages[0].Content.Text() != "Earlier tool facts and task summarized." || messages[1].Content[0].Call.ID != "recent-call" || messages[2].Result.Call != "recent-call" {
		t.Fatal(messages)
	}
}
