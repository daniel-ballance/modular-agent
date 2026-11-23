package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"reflect"
	"strings"
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
	if !reflect.DeepEqual(seen, []string{"model.delta", "model.delta", "model.stream.end"}) || len(filtered) != 0 || len(batches) != 5 || len(batches[0].Events) != 1 {
		t.Fatalf("got events %v, filtered %v, batches %+v", seen, filtered, batches)
	}
}

func TestHeldOutputOverflowIsAtomic(t *testing.T) {
	for _, mode := range []string{"segments", "single", "buffer", "replacement", "late block"} {
		t.Run(mode, func(t *testing.T) {
			h := New()
			if mode == "buffer" {
				limits := DefaultCapacityLimits()
				limits.Session.BufferedBytes = 1024
				h.UseCapacity(NewCapacity(limits))
			}
			segments := 0
			err := h.Load(api.Plugin{Name: "gate", Setup: func(a api.API) error {
				return a.Handle("output.batch", "", func(_ context.Context, v any) (api.Decision, error) {
					b := v.(api.OutputBatch)
					if b.Events[0].Kind != "model.delta" {
						return api.Decision{}, nil
					}
					wire := make([]portable.OutputEvent, 0, len(b.Events))
					for _, e := range b.Events {
						wire = append(wire, portable.ProjectOutput(e))
					}
					if n := len(api.JSON(wire)); n > portable.GateSegmentBytes {
						t.Errorf("oversized gate segment: %d", n)
					}
					segments++
					if segments == 2 && mode == "late block" {
						return api.Decision{Refuse: true}, nil
					}
					if segments == 2 && mode == "replacement" {
						b.Events[0].Data = api.JSON(api.Part{Type: "text", Text: strings.Repeat("y", portable.GateSegmentBytes)})
						return api.Decision{Value: b}, nil
					}
					return api.Decision{}, nil
				})
			}})
			if err != nil {
				t.Fatal(err)
			}
			a := h.API()
			var seen []string
			a.Subscribe(func(e api.Event) { seen = append(seen, e.Kind) })
			sizes := []int{portable.GateSegmentBytes / 2, portable.GateSegmentBytes / 2}
			if mode == "single" {
				sizes = []int{5, portable.GateSegmentBytes, 5}
			}
			if mode == "buffer" {
				sizes = []int{5, 1024, 5}
			}
			for _, n := range sizes {
				a.Emit(t.Context(), api.Event{Session: "s", Step: "step", Kind: "model.delta", Data: api.JSON(api.Part{Type: "text", Text: strings.Repeat("x", n)})})
			}
			if len(seen) != 0 {
				t.Fatal("early release")
			}
			a.Emit(t.Context(), api.Event{Session: "s", Step: "step", Kind: "model.stream.end"})
			switch mode {
			case "segments":
				if segments != 2 || !reflect.DeepEqual(seen, []string{"model.delta", "model.delta", "model.stream.end"}) {
					t.Fatal(segments, seen)
				}
			case "late block":
				if segments != 2 || len(seen) != 0 {
					t.Fatal(segments, seen)
				}
			default:
				if !reflect.DeepEqual(seen, []string{"output.overflow"}) {
					t.Fatal(segments, seen)
				}
			}
		})
	}
}
