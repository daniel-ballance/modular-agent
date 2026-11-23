package modular_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

const interfaceScript = `[{"toolCalls":[{"name":"pick_color","input":{"palette":"warm"}}]},{"text":"done"}]`

func interfaceOptions(ms int64) []modular.Option {
	return []modular.Option{modular.WithSeveralActors(true), modular.WithInterfaceTools(modular.InterfaceToolSource{
		SourceID: "palette", ActorID: "editor", RouteID: "editor-primary", ResultTimeoutMS: ms,
		Tools: []modular.ToolDefinition{{Name: "pick_color", Description: "Pick a color.", Parameters: json.RawMessage(`{"type":"object"}`), Callers: []string{"model"}}},
	}), modulartest.Script(interfaceScript)}
}

func interfaceSession(t *testing.T, ctx context.Context, a *modular.Agent) *modular.Session {
	t.Helper()
	s, err := a.Session(ctx, modular.SessionOptions{Actors: []modular.Actor{{ID: "editor", Kind: "program", Rights: []string{"watch", "tools"}}}})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func interfaceConnect(t *testing.T, a *modular.Agent, s *modular.Session) *modular.InterfaceToolConnection {
	t.Helper()
	c, err := a.ConnectInterfaceTools(s.ID(), modular.InterfaceToolConnectionOptions{ActorID: "editor", RouteID: "editor-primary"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestInterfaceResultFromNewConnectionContinuesWithoutInput(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	a := modulartest.Agent(t, interfaceOptions(30_000)...)
	s := interfaceSession(t, ctx, a)
	first := interfaceConnect(t, a, s)
	if err := first.Advertise("pick_color"); err != nil {
		t.Fatal(err)
	}
	origin, err := s.Prompt(ctx, "Pick a color.")
	if err != nil || origin.Outcome == nil || origin.Outcome.Kind != "completed" || len(origin.OpenToolCalls) != 1 {
		t.Fatalf("expected open call: %+v, %v", origin, err)
	}
	call, err := first.NextHandoff(ctx)
	if err != nil || call.Name != "pick_color" || call.ID != origin.OpenToolCalls[0] {
		t.Fatalf("handoff: %+v %v", call, err)
	}
	first.Close()
	second := interfaceConnect(t, a, s)
	status, err := second.ReportToolResult(ctx, modular.InterfaceToolReport{CallID: call.ID, Status: modular.Completed, Content: modular.Text("amber")})
	if err != nil || status != modular.InterfaceToolAccepted {
		t.Fatalf("report: %v, %v", status, err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	last, err := s.LastTurn(ctx)
	if err != nil || last == nil || last.Text != "done" || last.TurnID == origin.TurnID {
		t.Fatalf("continuation: %+v %v", last, err)
	}
	rows, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var starts, inputs, results int
	for _, row := range rows {
		switch row["kind"] {
		case "toolStarted":
			starts++
		case "inputAccepted":
			inputs++
		case "toolResult":
			results++
			if row["actorId"] != "editor" || row["turnId"] != origin.TurnID {
				t.Fatalf("wrong result attribution: %v", row)
			}
		case "modular-agent.interfaceHandoff":
			if row["data"] != nil {
				t.Fatalf("checkpoint data is private: %v", row)
			}
		}
	}
	if starts != 1 || inputs != 1 || results != 1 {
		t.Fatalf("got %d starts, %d inputs, %d results", starts, inputs, results)
	}
}
