package modular_test

import (
	"context"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func spanAttr(s tracetest.SpanStub, key string) string {
	for _, attr := range s.Attributes {
		if string(attr.Key) == key {
			return attr.Value.AsString()
		}
	}
	return ""
}

func TestJobCallbacksStayInTheJobTrace(t *testing.T) {
	for _, served := range []bool{false, true} {
		name := "local"
		if served {
			name = "served"
		}
		t.Run(name, func(t *testing.T) {
			mem := tracetest.NewInMemoryExporter()
			tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(mem))
			previous := otel.GetTracerProvider()
			otel.SetTracerProvider(tp)
			t.Cleanup(func() { otel.SetTracerProvider(previous); _ = tp.Shutdown(context.Background()) })
			jobs := make(chan *modular.Job, 1)
			plugin := modular.Plugin{Name: "fixture-jobs", Setup: func(r *modular.Registrar) error {
				if err := r.Jobs(modular.JobOwner{Cancel: func(context.Context, *modular.Job) error { return nil }}); err != nil {
					return err
				}
				return r.Tool(modular.NewTool("work", "Start work.", func(ctx context.Context, _ struct{}, tool *modular.ToolContext) (string, error) {
					job, err := tool.Jobs.Start(ctx, "fixture", nil)
					if err == nil {
						jobs <- job
					}
					return "started", err
				}))
			}}
			option := modular.WithPlugin(plugin)
			if served {
				option = modular.WithWirePlugin(plugin)
			}
			a := modulartest.Agent(t, option, modulartest.Script(`[{"toolCalls":[{"name":"work","input":{}}]},{"text":"done"},{"text":"reported"}]`))
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			result, err := s.Prompt(t.Context(), "start")
			if err != nil || len(result.ToolResults()) != 1 || result.ToolResults()[0].Status != "completed" {
				t.Fatalf("start: %+v, %v", result.ToolResults(), err)
			}
			var job *modular.Job
			select {
			case job = <-jobs:
			default:
				t.Fatal("tool did not start a job")
			}
			// End after the request has returned, with a caller from a different trace.
			wrongTrace, unrelated := tp.Tracer("fixture").Start(t.Context(), "unrelated", trace.WithNewRoot())
			defer unrelated.End()
			if err := job.Progress(wrongTrace, modular.Text("fixture-progress")); err != nil {
				t.Fatal(err)
			}
			if err := job.End(wrongTrace, modular.Outcome{Kind: "completed"}, modular.Text("fixture-result"), true); err != nil {
				t.Fatal(err)
			}
			if err := s.WaitIdle(t.Context()); err != nil {
				t.Fatal(err)
			}
			var jobSpan, toolSpan, startCallback, endClient, endServer, report tracetest.SpanStub
			for _, span := range mem.GetSpans() {
				switch span.Name {
				case "execute_tool work":
					toolSpan = span
				case "modular_agent.job":
					jobSpan = span
				case "modular_agent.input.admit":
					if len(span.Links) > 0 {
						report = span
					}
				case "modular_agent.plugin.request":
					switch spanAttr(span, "modular_agent.plugin.method") {
					case "host/jobs/start":
						startCallback = span
					case "host/jobs/end":
						if span.SpanKind == trace.SpanKindClient {
							endClient = span
						} else {
							endServer = span
						}
					}
				}
			}
			parent := toolSpan
			if served {
				parent = startCallback
			}
			if !jobSpan.SpanContext.IsValid() || jobSpan.Parent.SpanID() != parent.SpanContext.SpanID() || jobSpan.SpanContext.TraceID() != toolSpan.SpanContext.TraceID() || spanAttr(jobSpan, "modular_agent.job.id") != job.ID || spanAttr(jobSpan, "modular_agent.job.outcome") != "completed" {
				t.Fatalf("job span: %+v", jobSpan)
			}
			if len(report.Links) != 1 || report.Links[0].SpanContext.SpanID() != jobSpan.SpanContext.SpanID() || report.SpanContext.TraceID() != jobSpan.SpanContext.TraceID() {
				t.Fatalf("job report lost its job trace or link: %+v", report)
			}
			if served && (endClient.SpanContext.TraceID() != jobSpan.SpanContext.TraceID() || endServer.Parent.SpanID() != endClient.SpanContext.SpanID() || report.Parent.SpanID() != endServer.SpanContext.SpanID()) {
				t.Fatalf("served job callback chain: client %v server %v report parent %v", endClient.SpanContext, endServer.SpanContext, report.Parent)
			}
		})
	}
}
