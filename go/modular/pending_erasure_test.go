package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestProviderDeletionIsRetriedAfterRestart(t *testing.T) {
	ctx := t.Context()
	project, state, records := t.TempDir(), t.TempDir(), t.TempDir()
	calls := 0
	model := modular.ModelRef{Provider: "test", ID: "test"}
	build := func(fail bool) *modular.Agent {
		p := modular.Provider{ID: model.Provider, Supports: modular.ProviderSupport{KeepsState: true}, Models: func() []modular.ModelInfo {
			return []modular.ModelInfo{{ModelRef: model, ContextWindow: 4000, MaxOutput: 1000}}
		}, Request: func(context.Context, modular.ModelRef, modular.ModelRequest, *modular.ProviderContext) (modular.AssistantMessage, error) {
			return modular.AssistantMessage{Content: modular.Text("answer"), Stop: "finished"}, nil
		}, EraseState: func(_ context.Context, _ string, _ []string) (modular.ProviderErasure, error) {
			calls++
			if fail {
				return modular.ProviderErasure{}, errors.New("remote unavailable")
			}
			return modular.ProviderErasure{}, nil
		}}
		a, err := modular.New(ctx, modular.WithProject(project), modular.WithDataDir(state), modular.WithDurability(modular.Kept), modular.WithHistory(modular.FileHistory(records)), modular.WithModel(model.String()), modular.WithProvider(p))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = a.Close(ctx) })
		return a
	}
	a := build(true)
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prompt(ctx, "erase me"); err != nil {
		t.Fatal(err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	h, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var target string
	for _, e := range h {
		if e["kind"] == "input" {
			target, _ = e["id"].(string)
			break
		}
	}
	r, err := s.Erase(ctx, []string{target})
	if err != nil || !slices.Contains(r.OutOfReach, "unconfirmed Provider deletion") || calls != 1 {
		t.Fatalf("first erase: %+v, %v; Provider calls: %d", r, err, calls)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	b := build(false)
	reopened, err := b.OpenSession(ctx, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		r, err = reopened.Erase(ctx, []string{target})
		if err != nil || slices.Contains(r.OutOfReach, "unconfirmed Provider deletion") || calls != 2 {
			t.Fatalf("repeat erase: %+v, %v; Provider calls: %d", r, err, calls)
		}
	}
}

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
