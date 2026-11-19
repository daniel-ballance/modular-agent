package harness

import (
	"context"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
	"reflect"
	"testing"
)

func TestOutputBatchHoldsEachStreamAndFailsClosed(t *testing.T) {
	h := New()
	var batches []api.OutputBatch
	if err := h.Load(api.Plugin{Name: "batch-filter", Setup: func(a api.API) error {
		return a.Handle("output.batch", "", func(_ context.Context, v any) (api.Decision, error) {
			batch := v.(api.OutputBatch)
			batches = append(batches, batch)
			if batch.Recipient == "filtered" && batch.Events[0].Kind == "model.delta" {
				batch.Events = batch.Events[len(batch.Events)-1:]
				return api.Decision{Value: batch}, nil
			}
			if batch.Events[0].Call == "blocked" {
				return api.Decision{}, errors.New("lost plugin")
			}
			return api.Decision{}, nil
		})
	}}); err != nil {
		t.Fatal(err)
	}
	a := h.API()
	var seen, filtered []string
	a.Subscribe(func(e api.Event) { seen = append(seen, e.Kind) })
	a.(*client).SubscribeOutput(func(api.Event) string { return "filtered" }, func(e api.Event) { filtered = append(filtered, e.Kind) })
	emit := func(kind, step, call string) {
		a.Emit(context.Background(), api.Event{Kind: kind, Session: "session", Turn: "turn", Step: step, Call: call, Data: api.JSON(api.Part{Type: "text", Text: "test"})})
	}
	emit("model.delta", "step", "")
	emit("tool.progress", "step", "blocked")
	emit("model.delta", "step", "")
	if len(seen) != 0 || len(batches) != 0 {
		t.Fatalf("stream escaped before its end: %v", seen)
	}
	emit("tool.end", "step", "blocked")
	emit("model.stream.end", "step", "")
	if !reflect.DeepEqual(seen, []string{"model.delta", "model.delta", "model.stream.end"}) || len(filtered) != 0 || len(batches) != 4 || len(batches[0].Events) != 2 || len(batches[2].Events) != 3 {
		t.Fatalf("got events %v, filtered %v, batches %+v", seen, filtered, batches)
	}
}
