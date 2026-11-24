package modular_test

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

const nestedScript = `[{"toolCalls":[{"name":"parent","input":{}}]},{"text":"done"}]`

func callingTool(name, child string, opts ...modular.ToolOption) modular.Tool {
	return modular.NewTool(name, name, func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		r, err := tc.Tools.Call(ctx, child, struct{}{})
		return string(r.Status), err
	}, opts...)
}

func TestApprovalCoversNestedDispatch(t *testing.T) {
	var effects atomic.Int32
	leaf := modular.NewTool("leaf", "leaf", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
		effects.Add(1)
		return "done", nil
	}, modular.Callers("plugin"))
	asked := make(chan modular.Question, 3)
	a := modulartest.Agent(t, modular.WithApproval(modular.All), modular.WithApprovalCoversNested(true), modulartest.Script(nestedScript), modular.WithTool(callingTool("parent", "child")), modular.WithTool(callingTool("child", "leaf", modular.Callers("plugin"))), modular.WithTool(leaf), modular.WithOnQuestion(func(_ context.Context, q modular.Question) (modular.Answer, error) {
		asked <- q
		if q.Call.Name != "parent" {
			return modular.Decline("unexpected"), nil
		}
		return modular.Allow(), nil
	}))
	if a.Declaration()["approvalCoversNested"] != true {
		t.Fatal("missing covered approval declaration")
	}
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prompt(t.Context(), "Run."); err != nil {
		t.Fatal(err)
	}
	if len(asked) != 1 || effects.Load() != 1 {
		t.Fatalf("%d questions, %d effects", len(asked), effects.Load())
	}
	q := <-asked
	if !q.CoversNested {
		t.Fatal("approval did not disclose coverage")
	}
	checkCoverage(t, s, q, 2)
}

func TestCoveredApprovalBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name                              string
		policy                            modular.Approval
		cover, deny, readOnly, blockChild bool
		asks, starts                      int
	}{
		{"denied", modular.All, true, true, false, false, 1, 0},
		{"never", modular.Never, true, false, false, false, 0, 0},
		{"without coverage", modular.All, false, false, false, false, 2, 1},
		{"no explicit parent allow", modular.Ask, true, false, true, false, 1, 1},
		{"other gate refuses child", modular.All, true, false, false, true, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var asks, effects atomic.Int32
			var hints []modular.ToolOption
			if tc.readOnly {
				hints = append(hints, modular.ReadOnly())
			}
			child := modular.NewTool("child", "child", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
				effects.Add(1)
				return "done", nil
			})
			a := modulartest.Agent(t, modular.WithApproval(tc.policy), modular.WithApprovalCoversNested(tc.cover), modular.WithTool(callingTool("parent", "child", hints...)), modular.WithTool(child), modular.WithPlugin(modular.Plugin{Name: "guard", Setup: func(r *modular.Registrar) error {
				return r.OnToolBefore(func(_ context.Context, v modular.ToolBefore) (modular.Gate, error) {
					if tc.blockChild && v.Call.Name == "child" {
						return modular.Gate{Refuse: "blocked child"}, nil
					}
					return modular.Gate{}, nil
				})
			}}), modular.WithOnQuestion(func(_ context.Context, q modular.Question) (modular.Answer, error) {
				asks.Add(1)
				if q.CoversNested != (tc.cover && q.Call.Name == "parent") {
					t.Errorf("unexpected scope for %s: %v", q.Call.Name, q.CoversNested)
				}
				if tc.deny || q.Call.Name != "parent" {
					return modular.Decline("no"), nil
				}
				return modular.Allow(), nil
			}))
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.CallTool(t.Context(), "parent", struct{}{})
			if err != nil {
				t.Fatal(err)
			}
			h := records(t, s)
			if int(asks.Load()) != tc.asks || effects.Load() != 0 || len(h["toolStarted"]) != tc.starts {
				t.Fatalf("asks %d, effects %d, starts %d; result %+v", asks.Load(), effects.Load(), len(h["toolStarted"]), r)
			}
			if tc.starts == 1 && r.Text() != "refused" || tc.starts == 0 && r.Status != modular.Refused {
				t.Fatalf("result: %+v", r)
			}
		})
	}
	a := modulartest.Agent(t, modular.WithApprovalCoversNested(true))
	if _, ok := a.Declaration()["approvalCoversNested"]; ok {
		t.Fatal("declared without approval plugin")
	}
}

func TestWaitingParentCoversOnlyWhatTheRecordedViewSaid(t *testing.T) {
	for _, covered := range []bool{false, true} {
		name := "unmarked"
		if covered {
			name = "marked"
		}
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			var effects atomic.Int32
			child := modular.NewTool("child", "child", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
				effects.Add(1)
				return "child", nil
			})
			opts := []modular.Option{modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()), modular.WithProject(t.TempDir()), modular.WithEnvironment(modulartest.MemoryEnvironment()), modular.WithLateAnswersStartTurns(true), modular.WithApproval(modular.All), modular.WithMaxApprovalWaitMs(60000), modulartest.Script(nestedScript), modular.WithTool(callingTool("parent", "child")), modular.WithTool(child)}
			a := approvalAgent(t, append(opts, modular.WithApprovalCoversNested(covered)))
			s, _ := parkBump(t, a)
			id := s.ID()
			if err := a.Close(ctx); err != nil {
				t.Fatal(err)
			}
			// Enabling coverage on reopen cannot widen a view created without it.
			a = approvalAgent(t, append(opts, modular.WithApprovalCoversNested(true)))
			s, err := a.OpenSession(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			q := pollOne(t, s)
			if q.CoversNested != covered {
				t.Fatalf("scope changed on reopen: %+v", q)
			}
			if err := s.Answer(ctx, q.ID, modular.Allow()); err != nil {
				t.Fatal(err)
			}
			if err := s.WaitIdle(ctx); err != nil {
				t.Fatal(err)
			}
			if covered {
				if effects.Load() != 1 {
					t.Fatal("missing child effect")
				}
				checkCoverage(t, s, q, 1)
			} else {
				r := records(t, s)
				if effects.Load() != 0 || len(r["inputRequest"]) != 2 || len(r["toolStarted"]) != 1 {
					t.Fatalf("unmarked allow covered a child: %v", r["toolResult"])
				}
			}
		})
	}
}

type repeatableTestEnvironment struct{ *modulartest.MemoryEnv }

func (repeatableTestEnvironment) StopsOnCrash() bool { return true }

func TestRecoveredParentNeedsNewCoveringAllow(t *testing.T) {
	ctx := t.Context()
	entered := make(chan struct{})
	var asks atomic.Int32
	parent := modular.NewTool("parent", "parent", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		r, err := tc.Tools.Call(ctx, "child", struct{}{})
		if err != nil {
			return "", err
		}
		close(entered)
		<-ctx.Done()
		return r.Text(), ctx.Err()
	}, modular.SafeToRepeat())
	child := modular.NewTool("child", "child", func(context.Context, struct{}, *modular.ToolContext) (string, error) { return "done", nil })
	a := modulartest.Agent(t, modular.WithDataDir(t.TempDir()), modular.WithEnvironment(repeatableTestEnvironment{modulartest.MemoryEnvironment()}), modular.WithDurability(modular.Durable), modular.WithApproval(modular.All), modular.WithApprovalCoversNested(true), modular.WithTool(parent), modular.WithTool(child), modulartest.Script(nestedScript), modular.WithOnQuestion(func(_ context.Context, q modular.Question) (modular.Answer, error) {
		if asks.Add(1) == 1 {
			return modular.Allow(), nil
		}
		return modular.Decline("not again"), nil
	}))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	job, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _, _ = s.Prompt(job, "Run.") }()
	select {
	case <-entered:
	case <-done:
		t.Fatal("parent never ran")
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	fresh := modulartest.Restart(t, a)
	cancel()
	<-done
	s, err = fresh.OpenSession(ctx, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	r := records(t, s)
	questions := r["inputRequest"]
	if asks.Load() != 2 || len(questions) != 2 || questions[0]["requestId"] == questions[1]["requestId"] || len(r["toolStarted"]) != 2 {
		t.Fatalf("recovery: %d questions, starts %v", asks.Load(), r["toolStarted"])
	}
}

func checkCoverage(t *testing.T, s *modular.Session, q modular.Question, n int) {
	t.Helper()
	r := records(t, s)
	if len(r["inputRequest"]) != 1 || fields(fields(r["inputRequest"][0]["data"])["request"])["coversNested"] != true {
		t.Fatalf("requests: %v", r["inputRequest"])
	}
	seen := 0
	for _, e := range r["toolStarted"] {
		d := fields(e["data"])
		if e["toolCallId"] == q.Call.ID {
			if d["approvalCoveredBy"] != nil {
				t.Fatal("parent marked as nested")
			}
			continue
		}
		cover := fields(d["approvalCoveredBy"])
		if cover["toolCallId"] != q.Call.ID || cover["requestId"] != q.ID {
			t.Fatalf("wrong covering approval: %v", d)
		}
		seen++
	}
	if seen != n {
		t.Fatalf("%d covered starts, want %d", seen, n)
	}
}
