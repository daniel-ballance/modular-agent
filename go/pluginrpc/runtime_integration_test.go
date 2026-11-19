package pluginrpc_test

import (
	"context"
	"modular/api"
	"modular/vanilla"
	"testing"
	"time"
)

func TestHostedRuntimeContinuesAnsweredToolCall(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "durable-runtime"), childSpec("late-tool", "")})))
	opt := options(t)
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	a := h.API()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id, err := a.New(ctx, opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	capability, _ := a.Get("questions")
	q := capability.(api.Questions)
	defer q.Connect(id, "local-user")()
	if _, err := a.Submit(ctx, id, api.Input{Content: api.Text(`tool:probe {"defer":true}`)}); err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(ctx, id)
	if err != nil || out.Status != "completed" || len(out.Open) != 1 {
		t.Fatal(out, err)
	}
	call := out.Open[0].ID
	list, err := q.List(id)
	if err != nil || len(list) != 1 {
		t.Fatal(list, err)
	}
	if err := q.Answer(ctx, id, api.Answer{Request: list[0].ID, Value: "continued-marker"}); err != nil {
		t.Fatal(err)
	}
	// Answering schedules the keyed continuation as a separate turn.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		s, err := a.Snapshot(id)
		if err != nil {
			t.Fatal(err)
		}
		var results int
		var resultTurn string
		for _, e := range s.Branch() {
			if e.Kind == "tool.result" && e.Call == call {
				results++
				resultTurn = e.Turn
				if r := api.Decode[api.ToolResult](e.Data); r.Status != "completed" || r.Content.Text() != "continued-marker" {
					t.Fatal(r)
				}
			}
		}
		for _, e := range s.Branch() {
			if e.Kind == "turn.end" && e.Turn == resultTurn {
				o := api.Decode[api.Outcome](e.Data)
				if results != 1 || o.Status != "completed" || len(o.Open) != 0 {
					t.Fatal(results, o)
				}
				return
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("answered call did not complete")
		case <-ticker.C:
		}
	}
}
