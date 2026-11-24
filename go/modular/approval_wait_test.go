package modular_test

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestWaitingApprovalRequiresDeliveryOnTheAnsweringHandle(t *testing.T) {
	ctx := t.Context()
	var count atomic.Int32
	bump := modular.NewTool("bump", "Bump a counter.", func(context.Context, struct{}, *modular.ToolContext) (string, error) { count.Add(1); return "one", nil })
	a := modulartest.Agent(t, modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()), modular.WithApproval(modular.All), modular.WithLateAnswersStartTurns(true), modular.WithMaxApprovalWaitMs(30000), modular.WithTool(bump), modulartest.Script(`[{"toolCalls":[{"name":"bump","input":{}}]},{"text":"done"}]`))
	s, err := a.Session(ctx, modular.SessionOptions{Settings: modular.Settings{"approvalWait": "untilDeadline"}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.Prompt(ctx, "Bump.")
	if err != nil || r.Outcome == nil || r.Outcome.Kind != "completed" || len(r.OpenToolCalls) != 1 {
		t.Fatalf("origin: %+v, %v", r, err)
	}
	if err = s.WaitIdle(ctx); err != nil || count.Load() != 0 {
		t.Fatalf("idle: %d effects, %v", count.Load(), err)
	}
	qs, err := s.Questions(ctx)
	if err != nil || len(qs) != 1 || qs[0].Deadline == nil || qs[0].ApprovalWait != "untilDeadline" || qs[0].Call == nil || qs[0].Call.Name != "bump" {
		t.Fatalf("questions: %+v, %v", qs, err)
	}
	id := qs[0].ID
	if err = s.Answer(ctx, id, modular.Allow()); err == nil {
		t.Fatal("a listing authorized the call")
	}
	if _, err = s.Questions(ctx, modular.QuestionsOptions{Present: true}); err != nil {
		t.Fatal(err)
	}
	other, err := s.As("user")
	if err != nil {
		t.Fatal(err)
	}
	if err = other.Answer(ctx, id, modular.Allow()); err == nil {
		t.Fatal("a different handle spent the view")
	}
	if err = s.Answer(ctx, id, modular.Allow()); err != nil {
		t.Fatal(err)
	}
	if err = s.WaitIdle(ctx); err != nil || count.Load() != 1 {
		hist, _ := s.History(ctx)
		for _, e := range hist {
			t.Logf("%s %s %s %v", e["kind"], e["turnId"], e["toolCallId"], e["message"])
		}
		t.Fatalf("continuation: %d effects, %v", count.Load(), err)
	}
	if err = s.Answer(ctx, id, modular.Allow()); err == nil {
		t.Fatal("accepted twice")
	}
}
