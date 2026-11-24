package harness_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"path/filepath"
	"testing"
)

func TestHistoryBranchesMoveForkAndRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	project := t.TempDir()
	makeHarness := func() *harness.Harness {
		h := harness.New()
		if err := h.Load(history.Plugin(dir)); err != nil {
			t.Fatal(err)
		}
		return h
	}
	h := makeHarness()
	a := h.API()
	id, err := a.New(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	runtimetest.Publish(t, a, id)
	setup, _ := a.Snapshot(id)
	prefix := len(setup.Entries)
	first, err := a.Record(ctx, id, api.Entry{Kind: "test.note", Visible: true, Content: api.Text("first")})
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.Record(ctx, id, api.Entry{Kind: "test.note", Visible: true, Content: api.Text("second")})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Move(ctx, id, first.ID, true); err == nil {
		t.Fatal("unsupported rewind allowed")
	}
	if err = a.Move(ctx, id, first.ID, false); err != nil {
		t.Fatal(err)
	}
	snap, _ := a.Snapshot(id)
	if snap.Position != first.ID || len(snap.Entries) != prefix+3 || len(snap.Branch()) != prefix+1 || snap.Branch()[0].Kind != "plugins.set" {
		t.Fatal(snap)
	}
	fork, err := a.Fork(ctx, id, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	branch, _ := a.Snapshot(fork)
	if len(branch.Entries) < prefix+2 || branch.Entries[prefix].Copies[0] != first.ID || branch.Entries[len(branch.Entries)-1].Kind != "plugins.set" {
		t.Fatal(branch)
	}
	third, _ := a.Record(ctx, id, api.Entry{Kind: "test.note", Visible: true, Content: api.Text("third")})
	if third.Parent != first.ID || third.Parent == second.ID {
		t.Fatal(third)
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	h = makeHarness()
	defer h.Close()
	a = h.API()
	if err = a.Open(ctx, id); err != nil {
		t.Fatal(err)
	}
	snap, _ = a.Snapshot(id)
	if snap.Position != third.ID || len(snap.Entries) != prefix+4 {
		t.Fatal(snap)
	}
	list, err := a.List(filepath.Clean(project))
	if err != nil || len(list) != 2 {
		t.Fatal(list, err)
	}
}
func TestErasureReloadsOpenSessionsAndForks(t *testing.T) {
	h := harness.New()
	defer h.Close()
	_ = h.Load(history.Plugin(t.TempDir()))
	a := h.API()
	ctx := context.Background()
	id, _ := a.New(ctx, t.TempDir())
	runtimetest.Publish(t, a, id)
	source, _ := a.Record(ctx, id, api.Entry{Kind: "input", Visible: true, Content: api.Text("private")})
	summary, _ := a.Record(ctx, id, api.Entry{Kind: "summary", Visible: true, Copies: []string{source.ID}, Content: api.Text("private paraphrase")})
	fork, err := a.Fork(ctx, id, summary.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Erase(ctx, id, []string{source.ID}); err != nil {
		t.Fatal(err)
	}
	for _, sid := range []string{id, fork} {
		snap, _ := a.Snapshot(sid)
		for _, e := range snap.Entries {
			if (e.WasKind("input") || e.WasKind("summary")) && (!e.IsErased() || len(e.Content) > 0) {
				t.Fatal(e)
			}
		}
	}
}
