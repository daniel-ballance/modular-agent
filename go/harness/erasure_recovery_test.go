package harness

import (
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/history"
)

func TestErasureSettlesInterruptedWorkBeforeDeletingInputs(t *testing.T) {
	store, err := history.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	snap := api.Session{ID: "affected", Project: t.TempDir(), Version: 1, Actor: "local-user"}
	appendEntry(&snap, api.Entry{ID: "admission", Kind: "input.accepted", Data: api.JSON(api.Input{ID: "input", Key: "key", Content: api.Text("private")})}, "harness", true)
	appendEntry(&snap, api.Entry{Kind: "turn.start", Turn: "turn", Data: api.JSON(api.TurnStart{Input: "input"})}, "harness", true)
	appendEntry(&snap, api.Entry{Kind: "tool.started", Turn: "turn", Step: "step", Call: "call", Data: api.JSON(api.Call{ID: "call", Name: "tool"})}, "runtime", true)
	appendEntry(&snap, api.Entry{Kind: "job.start", Job: "job", Data: api.JSON(api.Job{ID: "job", Kind: "test", Report: true})}, "jobs", true)
	lease, err := store.Acquire(snap.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := lease.Save(snap); err != nil {
		t.Fatal(err)
	}
	intents := []api.ErasureIntent{{ID: "erase", Source: snap.ID, Targets: []string{"admission"}, Copies: []api.ErasureCopy{{EntryPair: api.EntryPair{SessionID: snap.ID, ID: "admission"}}}}}
	record, err := reconcileCopies(lease, snap, &intents)
	if err != nil {
		t.Fatal(err)
	}
	if active, queued := recovery(record); active != nil || len(queued) != 0 || unfinished(record) || !intents[0].Copies[0].Complete {
		t.Fatal("erasure left work runnable or the tombstone unconfirmed")
	}
	want := []string{"job.end", "job.cleanup", "tool.result", "turn.end", "erasure"}
	for i, kind := range want {
		if got := record.Entries[4+i]; got.Kind != kind {
			t.Fatalf("expected %s before tombstone, got %+v", kind, got)
		}
	}
	if got := api.Decode[api.ToolResult](record.Entries[6].Data); got.Status != "unknown" {
		t.Fatalf("interrupted call: %+v", got)
	}
	again, err := reconcileCopies(lease, record, &intents)
	if err != nil || len(again.Entries) != len(record.Entries) {
		t.Fatalf("repeated recovery appended bookkeeping: %v", err)
	}
}
