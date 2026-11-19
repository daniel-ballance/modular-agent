package pluginrpc

import (
	"context"
	"modular/api"
	"reflect"
	"strings"
	"testing"
)

func TestConformanceOutputRedactsAcrossEvents(t *testing.T) {
	payload := parseOutput([]byte(`{"events":[{"type":"text","data":{"delta":"the conformance-","stepId":"step"}},{"type":"reasoning","data":{"delta":"separate"}},{"type":"text","data":{"delta":"secret is here","stepId":"step"}},{"type":"vendor.note","data":{"flag":false,"n":9007199254740993,"items":[null,{"text":"conformance-secret"}]}}]}`))
	out, err := redactOutput(context.Background(), "output", payload)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"events":[{"data":{"delta":"the [redacted]","stepId":"step"},"type":"text"},{"data":{"delta":"separate"},"type":"reasoning"},{"data":{"delta":" is here","stepId":"step"},"type":"text"},{"data":{"flag":false,"items":[null,{"text":"[redacted]"}],"n":9007199254740993},"type":"vendor.note"}]}`
	if got := string(mustJSON(out)); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestHostedRuntimeCancellationTakesPrecedenceOverCallbackFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	w := runtimeWork{turnContext: ctx}
	out := api.Outcome{Status: "failed", Error: "callback failed first"}
	cancel()
	w.honorCancel(&out)
	if out.Status != "cancelled" || out.Error != "" {
		t.Fatal(out)
	}
	done := api.Outcome{Status: "completed"}
	w.honorCancel(&done)
	if done.Status != "completed" {
		t.Fatal(done)
	}
}

func TestOutputTranslationRoundTrip(t *testing.T) {
	call := api.Call{ID: "call", Name: "tool", Input: api.JSON(map[string]string{"arg": "conformance-secret"})}
	result := api.ToolResult{Call: call.ID, Status: "completed", Content: api.Text("conformance-secret")}
	for _, tc := range []struct {
		e    api.Event
		wire string
	}{
		{api.Event{Kind: "model.delta", Step: "step", Data: api.JSON(api.Part{Type: "text", Text: "conformance-secret"})}, "text"},
		{api.Event{Kind: "tool.requested", Call: call.ID, Data: api.JSON(call)}, "toolCall"},
		{api.Event{Kind: "tool.progress", Call: call.ID, Data: api.JSON("conformance-secret")}, "toolOutput"},
		{api.Event{Kind: "tool.end", Call: call.ID, Data: api.JSON(result)}, "toolResult"},
		{api.Event{Kind: "history.added", Data: api.JSON(api.Entry{ID: "entry", Kind: "input", Content: api.Text("conformance-secret")})}, "entry"},
		{api.Event{Kind: "turn.end", Turn: "turn", Data: api.JSON(api.Outcome{Status: "completed", Result: api.Text("conformance-secret")})}, "turnEnded"},
		{api.Event{Kind: "interface.answer", Method: "_modular-agent/history", Data: api.JSON("conformance-secret")}, "reply"},
	} {
		t.Run(tc.wire, func(t *testing.T) {
			wire := outputOut(tc.e)
			if wire.Type != tc.wire {
				t.Fatal(wire.Type)
			}
			unchanged, err := outputIn(tc.e, wire)
			if err != nil || !reflect.DeepEqual(unchanged, tc.e) {
				t.Fatal(unchanged, err)
			}
			wire.Data = []byte(strings.ReplaceAll(string(wire.Data), "conformance-secret", "[redacted]"))
			got, err := outputIn(tc.e, wire)
			if err != nil || got.Kind != tc.e.Kind || !strings.Contains(string(got.Data), "[redacted]") || strings.Contains(string(got.Data), "conformance-secret") {
				t.Fatal(got, err)
			}
			wire.Data = []byte(`{}`)
			if _, err := outputIn(tc.e, wire); err == nil {
				t.Fatal("unmappable change passed")
			}
		})
	}
}
