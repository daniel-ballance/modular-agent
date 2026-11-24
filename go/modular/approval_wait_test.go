package modular_test

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestLateApprovalResultPrecedesNewerInputInModelRequest(t *testing.T) {
	ctx := t.Context()
	var last atomic.Pointer[modular.ModelRequest]
	observe := modular.Plugin{Name: "observe-request", Setup: func(r *modular.Registrar) error {
		return r.OnProviderRequest(func(_ context.Context, p modular.ProviderRequest) (*modular.ModelRequest, error) {
			last.Store(&p.Request)
			return nil, nil
		})
	}}
	limits := modular.DefaultCapacityLimits()
	limits.Session.Calls = 1
	opts := bumpOptions(t, t.TempDir(), modular.Kept, false, "counter", "Bump.", nil)
	a := approvalAgent(t, append(opts, modular.WithCapacityLimits(limits), modular.WithPlugin(observe)))
	s, call := parkBump(t, a)
	probe, err := s.Prompt(ctx, "Newer input")
	if err != nil || probe.Outcome == nil || probe.Outcome.Limit != "capacity" {
		t.Fatalf("probe: %+v, %v", probe, err)
	}
	last.Store(nil)
	if err := s.Answer(ctx, pollOne(t, s).ID, modular.Decline("no")); err != nil {
		t.Fatal(err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	req := last.Load()
	if req == nil {
		t.Fatal("no continuation request")
	}
	m := req.Messages
	if len(m) != 4 || m[0].Content.Text() != "Bump." || m[1].Role != "assistant" ||
		len(m[1].Content) != 1 || m[1].Content[0].Type != "toolCall" ||
		m[2].Role != "toolResult" || m[2].ToolCallID != call || !m[2].IsError ||
		m[3].Role != "user" || m[3].Content.Text() != "Newer input" {
		t.Fatalf("want original input, call, refused result, newer input; got %+v", m)
	}
}

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
