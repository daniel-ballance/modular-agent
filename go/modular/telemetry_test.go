package modular_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric/noop"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

type failedSpanExport struct{}

func (failedSpanExport) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	return errors.New("fixture exporter failure")
}
func (failedSpanExport) Shutdown(context.Context) error { return nil }

func TestTelemetryMapping(t *testing.T) {
	ctx := t.Context()
	for _, mode := range []string{"no SDK", "failed exporter", "in memory"} {
		t.Run(mode, func(t *testing.T) {
			mem := tracetest.NewInMemoryExporter()
			reader := sdkmetric.NewManualReader()
			switch mode {
			case "failed exporter":
				tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(failedSpanExport{}), sdktrace.WithSampler(sdktrace.AlwaysSample()))
				t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
				otel.SetTracerProvider(tp)
			case "in memory":
				tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(mem), sdktrace.WithSampler(sdktrace.AlwaysSample()))
				mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
				t.Cleanup(func() { _ = tp.Shutdown(context.Background()); _ = mp.Shutdown(context.Background()) })
				otel.SetTracerProvider(tp)
				otel.SetMeterProvider(mp)
			}
			defer otel.SetTracerProvider(tracenoop.NewTracerProvider())
			defer otel.SetMeterProvider(noop.NewMeterProvider())
			effects := 0
			tool := modular.NewTool("check", "sentinel-definition", func(_ context.Context, in struct {
				Value string `json:"value"`
			}, _ *modular.ToolContext) (string, error) {
				effects++
				if in.Value != "sentinel-argument" {
					return "", fmt.Errorf("invalid test input")
				}
				return "sentinel-tool-result", nil
			})
			a := modulartest.Agent(t, modular.WithAgentName("fixture"), modular.WithModel(modulartest.ScriptedModel), modulartest.Script(`[{"toolCalls":[{"name":"check","input":{"value":"sentinel-argument"}}],"usage":{"input":10,"output":3}},{"text":"sentinel-completion","reasoning":"sentinel-reasoning","usage":{"input":12,"output":2}}]`), modular.WithTool(tool))
			if got := a.Declaration()["telemetry"]; got != 1 {
				t.Fatalf("telemetry declaration: %v", got)
			}
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.Prompt(ctx, "sentinel-prompt")
			if err != nil || r.Outcome.Kind != "completed" || effects != 1 {
				t.Fatalf("prompt: %#v %v effects=%d", r.Outcome, err, effects)
			}
			if mode != "in memory" {
				return
			}
			if err := s.Close(ctx); err != nil {
				t.Fatal(err)
			}
			got := mem.GetSpans()
			byName := map[string][]tracetest.SpanStub{}
			for _, s := range got {
				for _, v := range []any{s.Name, s.Attributes, s.Events, s.Status, s.Links, s.Resource} {
					if strings.Contains(fmt.Sprint(v), "sentinel-") {
						t.Fatal("fixture content in exported span")
					}
				}
				byName[s.Name] = append(byName[s.Name], s)
			}
			for name, count := range map[string]int{"modular_agent.session.open": 1, "modular_agent.input.admit": 1, "invoke_agent fixture": 1, "modular_agent.step": 2, "chat script": 2, "execute_tool check": 1} {
				if len(byName[name]) != count {
					t.Fatalf("%s: got %d want %d; spans %v", name, len(byName[name]), count, byName)
				}
			}
			parentIs := func(child, parent string) {
				for _, c := range byName[child] {
					matched := false
					for _, p := range byName[parent] {
						matched = matched || c.Parent.SpanID() == p.SpanContext.SpanID()
					}
					if !matched {
						t.Errorf("%s is not under %s", child, parent)
					}
				}
			}
			parentIs("invoke_agent fixture", "modular_agent.input.admit")
			parentIs("modular_agent.step", "invoke_agent fixture")
			parentIs("chat script", "modular_agent.step")
			parentIs("execute_tool check", "modular_agent.step")
			for name, operation := range map[string]string{"modular_agent.session.open": "new", "modular_agent.session.close": "close"} {
				spans := byName[name]
				if len(spans) != 1 || spanAttr(spans[0], "modular_agent.session.operation") != operation || spanAttr(spans[0], "gen_ai.conversation.id") != s.ID() {
					t.Errorf("wrong %s span: %v", name, spans)
				}
			}
			for _, commit := range byName["modular_agent.history.commit"] {
				if !commit.Parent.IsValid() || spanAttr(commit, "modular_agent.history.commit.status") != "committed" {
					t.Errorf("history commit lacks its recorded status or parent: %v", commit)
				}
			}
			if byName["chat script"][0].SpanKind != trace.SpanKindInternal {
				t.Error("scripted inference should be internal")
			}
			var m metricdata.ResourceMetrics
			if err := reader.Collect(ctx, &m); err != nil {
				t.Fatal(err)
			}
			for _, scope := range m.ScopeMetrics {
				for _, v := range scope.Metrics {
					switch data := v.Data.(type) {
					case metricdata.Histogram[float64]:
						if len(data.DataPoints) != 1 || data.DataPoints[0].Count != 2 {
							t.Errorf("duration: %v", data)
						}
					case metricdata.Sum[int64]:
						want := int64(5)
						if strings.HasSuffix(v.Name, "input_tokens") {
							want = 22
						}
						if len(data.DataPoints) != 1 || data.DataPoints[0].Value != want {
							t.Errorf("%s: %v", v.Name, data)
						}
					}
				}
			}
		})
	}
}
