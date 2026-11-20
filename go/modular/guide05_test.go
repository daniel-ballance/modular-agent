package modular_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestReopensAnInterruptedSession(t *testing.T) {
	for _, tc := range []struct {
		durability modular.Durability
		outcome    string
	}{{modular.Kept, "failed"}, {modular.Durable, "completed"}} {
		t.Run(string(tc.durability), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			started := make(chan struct{})
			var starts atomic.Int32
			lookup := modular.NewTool("lookup_tide", "Read the tide time.",
				func(ctx context.Context, _ struct{}, _ *modular.ToolContext) (string, error) {
					if starts.Add(1) == 1 {
						close(started)
						<-ctx.Done()
						return "", ctx.Err()
					}
					return "14:02", nil
				}, modular.ReadOnly(), modular.SafeToRepeat())
			agent := modulartest.Agent(t, modular.WithDataDir(t.TempDir()),
				modular.WithDurability(tc.durability), modular.WithTool(lookup),
				modulartest.Script(`[
					{"toolCalls": [{"name": "lookup_tide", "input": {}}]},
					{"text": "The tide time could not be confirmed."}
				]`))
			session, err := agent.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			id := session.ID()
			if _, err := session.Send(ctx, "Find the tide time.", modular.Now); err != nil {
				t.Fatal(err)
			}
			select {
			case <-started:
			case <-ctx.Done():
				t.Fatal("the tool must start before the crash")
			}

			agent = modulartest.Restart(t, agent)
			reopened, err := agent.OpenSession(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			turn, err := reopened.LastTurn(ctx)
			if err != nil || turn == nil || turn.Outcome == nil || turn.Outcome.Kind != tc.outcome {
				t.Fatalf("want %s; got %+v, %v", tc.outcome, turn, err)
			}
			results := turn.ToolResults()
			if len(results) != 1 || results[0].Status != modular.OutcomeUnknown || starts.Load() != 1 {
				t.Fatalf("got %+v from %d starts", results, starts.Load())
			}
		})
	}
}
