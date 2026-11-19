package guardrail_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/guardrail"
	"github.com/OWNER/modular-agent/go/harness"
	"strings"
	"testing"
)

func TestToolInputPiecesAndFailedAttemptsCannotBypassGate(t *testing.T) {
	h := harness.New()
	if err := h.Load(guardrail.Plugin([]string{"secret-value"})); err != nil {
		t.Fatal(err)
	}
	var seen []api.Event
	h.API().Subscribe(func(e api.Event) { seen = append(seen, e) })
	ctx := context.Background()
	for _, piece := range []string{"secret-", "value"} {
		h.API().Emit(ctx, api.Event{Kind: "model.delta", Session: "session", Turn: "turn", Step: "step", Data: api.JSON(api.Part{Type: "tool_input", Text: piece})})
	}
	if len(seen) != 0 {
		t.Fatal("tool input escaped before complete stream", seen)
	}
	h.API().Emit(ctx, api.Event{Kind: "model.stream.end", Session: "session", Turn: "turn", Step: "step"})
	if len(seen) != 1 || strings.Contains(string(api.JSON(seen)), "secret-value") {
		t.Fatal(seen)
	}
	seen = nil
	h.API().Emit(ctx, api.Event{Kind: "model.delta", Session: "session", Turn: "turn", Step: "failure", Data: api.JSON(api.Part{Type: "text", Text: "secret-"})})
	h.API().Emit(ctx, api.Event{Kind: "model.stream.end", Session: "session", Turn: "turn", Step: "failure", Data: api.JSON("failed")})
	if strings.Contains(string(api.JSON(seen)), "secret-") {
		t.Fatal("failed attempt flushed partial secret", seen)
	}
}
