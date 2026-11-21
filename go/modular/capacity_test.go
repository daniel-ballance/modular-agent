package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestModelCallListCapacitySettlesResponseWithoutDispatch(t *testing.T) {
	const script = `[{"toolCalls":[{"name":"demo","input":{}},{"name":"demo","input":{}}],"usage":{"input":12,"output":5}}]`
	for _, placement := range []string{"built-in", "custom", "served"} {
		t.Run(placement, func(t *testing.T) {
			limits := modular.DefaultCapacityLimits()
			limits.Session.Calls = 1
			tool := modular.NewTool("demo", "must not run", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
				t.Error("unreserved call ran")
				return "ran", nil
			})
			opts := []modular.Option{modular.WithCapacityLimits(limits), modular.WithTool(tool), modulartest.Script(script)}
			plugin := modular.Plugin{Name: "limited-runtime", Replaces: []string{"runtime"}, Setup: func(r *modular.Registrar) error {
				return r.Runtime(modular.NewRuntime(demoRuntime{}))
			}}
			switch placement {
			case "custom":
				opts = append(opts, modular.WithPlugin(plugin))
			case "served":
				opts = append(opts, modulartest.OverWire(plugin))
			}
			a := modulartest.Agent(t, opts...)
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			out, err := s.Prompt(t.Context(), "call tools")
			if err != nil || out.Outcome.Kind != "limit" || out.Outcome.Limit != "capacity" {
				t.Fatalf("want capacity limit: %+v %v", out, err)
			}
			entries, err := s.History(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			var responses int
			for _, e := range entries {
				switch e["kind"] {
				case "response":
					responses++
					var msg modular.AssistantMessage
					data, err := json.Marshal(e["message"])
					if err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(data, &msg); err != nil || msg.Stop != "failed" || len(msg.Content) != 0 || msg.Usage.Input != 12 || msg.Usage.Output != 5 {
						t.Fatalf("unexpected bounded response %s: %v", data, err)
					}
				case "toolCall", "toolCallStarted":
					t.Fatal(e)
				}
			}
			if responses != 1 {
				t.Fatalf("recorded %d responses: %v", responses, entries)
			}
		})
	}
}

func TestRestartKeepsAnOutstandingProposalAboveTheNewCeiling(t *testing.T) {
	ctx := t.Context()
	project, state := t.TempDir(), t.TempDir()
	build := func(l modular.CapacityLimits) *modular.Agent {
		a, err := modular.New(ctx, modular.WithDataDir(state), modular.WithProject(project), modular.WithDurability(modular.Kept), modular.WithSeveralActors(true), modular.WithCapacityLimits(l))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = a.Close(ctx) })
		return a
	}
	limits := modular.DefaultCapacityLimits()
	a := build(limits)
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	held, err := s.Send(ctx, "retain this proposal", modular.Propose, modular.WithInputKey("held"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Send(ctx, "retain this too", modular.Propose)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	limits.Agent.Inputs = 1
	b := build(limits)
	other, err := b.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if refused, err := other.Send(ctx, "unreserved", modular.Propose); refused.InputID != "" || err == nil {
		t.Fatalf("fresh work stole a reservation: %+v, %v", refused, err)
	}
	old, err := b.OpenSession(ctx, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	dup, err := old.Send(ctx, "different payload", modular.Propose, modular.WithInputKey("held"))
	if err != nil || !dup.Duplicate || dup.InputID != held.InputID {
		t.Fatal(dup, err)
	}
	if err := old.Withdraw(ctx, held.InputID); err != nil {
		t.Fatal(err)
	}
	if err := old.Withdraw(ctx, second.InputID); err != nil {
		t.Fatal(err)
	}
	if admitted, err := other.Send(ctx, "capacity returned", modular.Propose); err != nil || admitted.InputID == "" {
		t.Fatal(admitted, err)
	}
}

func TestConcurrentAdmissionsShareTheNoTenantBucket(t *testing.T) {
	limits := modular.DefaultCapacityLimits()
	limits.Tenant.Inputs = 1
	a, err := modular.New(t.Context(), modular.WithProject(t.TempDir()), modular.WithSeveralActors(true), modular.WithCapacityLimits(limits))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	sessions := make([]*modular.Session, 2)
	for i := range sessions {
		sessions[i], err = a.Session(t.Context())
		if err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	var receipt [2]modular.InputReceipt
	var refusal [2]error
	start := make(chan struct{})
	for i, s := range sessions {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			receipt[i], refusal[i] = s.Send(t.Context(), "held proposal", modular.Propose, modular.WithInputKey("once"))
		}()
	}
	close(start)
	wg.Wait()
	winner, loser := 0, 1
	if refusal[0] != nil {
		winner, loser = 1, 0
	}
	var sdk *modular.Error
	if refusal[winner] != nil || !errors.As(refusal[loser], &sdk) || sdk.Code != modular.Busy || receipt[loser].InputID != "" {
		t.Fatalf("want one admission and one busy without receipt: %v, %v", receipt, refusal)
	}
	again, err := sessions[winner].Send(t.Context(), "held proposal", modular.Propose, modular.WithInputKey("once"))
	if err != nil || !again.Duplicate || again.InputID != receipt[winner].InputID {
		t.Fatal(again, err)
	}
	if err := sessions[winner].Withdraw(t.Context(), receipt[winner].InputID); err != nil {
		t.Fatal(err)
	}
	again, err = sessions[loser].Send(t.Context(), "held proposal", modular.Propose, modular.WithInputKey("once"))
	if err != nil || again.Duplicate || again.InputID == "" {
		t.Fatal(again, err)
	}
}
