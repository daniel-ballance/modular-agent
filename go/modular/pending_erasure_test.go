package modular_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestPendingErasureSurvivesHeldWriterAndHandoff(t *testing.T) {
	ctx := t.Context()
	project, state, records := t.TempDir(), t.TempDir(), t.TempDir()
	build := func() *modular.Agent {
		a, err := modular.New(ctx, modular.WithProject(project), modular.WithDataDir(state), modular.WithDurability(modular.Kept), modular.WithHistory(modular.FileHistory(records)), modulartest.Script(`[{"text":"answer"}]`))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = a.Close(ctx) })
		return a
	}
	a := build()
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	const payload = "input that must not survive the tombstone"
	if _, err = s.Prompt(ctx, payload, modular.WithInputKey("source-key")); err != nil {
		t.Fatal(err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	entries, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var target string
	for _, e := range entries {
		if e["kind"] == "input" {
			target, _ = e["id"].(string)
		}
	}
	if target == "" {
		t.Fatal("no taken input")
	}
	fork, err := s.Fork(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fk, source := fork.ID(), s.ID()
	if err := fork.Close(ctx); err != nil {
		t.Fatal(err)
	}
	b := build()
	held, err := b.OpenSession(ctx, fk)
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.Erase(ctx, []string{target, target})
	if err != nil || len(report.Erased) == 0 || len(report.Pending) == 0 {
		t.Fatal(report, err)
	}
	for _, pair := range report.Pending {
		if pair.SessionID != fk {
			t.Fatal("only the held fork can still be pending", report)
		}
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := held.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.Close(ctx); err != nil {
		t.Fatal(err)
	}
	c := build()
	reopened, err := c.OpenSession(ctx, fk)
	if err != nil {
		t.Fatal(err)
	}
	entries, err = reopened.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(entries)
	if err != nil || strings.Contains(string(data), payload) {
		t.Fatal(string(data), err)
	}
	original, err := c.OpenSession(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := original.Send(ctx, payload, modular.Now, modular.WithInputKey("source-key"))
	if err != nil || !duplicate.Erased || !duplicate.Duplicate || duplicate.InputID != "" {
		t.Fatal(duplicate, err)
	}
	repeated, err := original.Erase(ctx, []string{target})
	if err != nil || len(repeated.Pending) != 0 || len(repeated.Erased) != len(report.Pending)+len(report.Erased) {
		t.Fatal(repeated, err)
	}
}
