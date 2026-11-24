package modular_test

import (
	"context"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestWaitingApprovalDoesNotTraceTheIdleInterval(t *testing.T) {
	for _, served := range []bool{false, true} {
		mem := tracetest.NewInMemoryExporter()
		tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(mem), sdktrace.WithSampler(sdktrace.AlwaysSample()))
		previous := otel.GetTracerProvider()
		otel.SetTracerProvider(tp)
		func() {
			defer otel.SetTracerProvider(previous)
			defer tp.Shutdown(context.Background())
			a := approvalAgent(t, bumpOptions(t, t.TempDir(), modular.Kept, served, "counter", "Bump.", nil))
			s, _ := parkBump(t, a)
			events := func(name string) int {
				n := 0
				for _, s := range mem.GetSpans() {
					for _, e := range s.Events {
						if e.Name == name {
							n++
						}
					}
				}
				return n
			}
			spans := func(prefix string) []tracetest.SpanStub {
				var spans []tracetest.SpanStub
				for _, s := range mem.GetSpans() {
					if strings.HasPrefix(s.Name, prefix) {
						spans = append(spans, s)
					}
				}
				return spans
			}
			if len(spans("invoke_agent")) != 1 || events("modular_agent.question.open") != 1 || events("modular_agent.question.close") != 0 || len(spans("execute_tool")) != 0 {
				t.Fatalf("served=%t: expected ended origin, one open and no dispatch", served)
			}
			if err := s.Answer(t.Context(), pollOne(t, s).ID, modular.Allow()); err != nil {
				t.Fatal(err)
			}
			if err := s.WaitIdle(t.Context()); err != nil {
				t.Fatal(err)
			}
			turns := spans("invoke_agent")
			if len(turns) != 2 || len(turns[1].Links) != 1 || turns[1].Links[0].SpanContext.SpanID() != turns[0].SpanContext.SpanID() || events("modular_agent.question.close") != 1 || len(spans("execute_tool")) != 1 {
				t.Fatal("continuation did not link or spend exactly one approval")
			}
		}()
	}
}
