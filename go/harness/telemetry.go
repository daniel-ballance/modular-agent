package harness

import (
	"context"
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type turnWireKey struct{}

func turnWire(ctx context.Context) *telemetry.Wire {
	w, _ := ctx.Value(turnWireKey{}).(*telemetry.Wire)
	return w
}

func savedTurn(s api.Session, turn string) (sc trace.SpanContext) {
	for _, e := range s.Branch() {
		if e.Turn != turn || e.IsErased() || e.Session != s.ID {
			continue
		}
		if e.Kind != "turn.start" && (e.Kind != telemetry.TurnTrace || e.Writer != "harness") {
			continue
		}
		w := api.Decode[struct {
			TraceContext *telemetry.Wire `json:"traceContext"`
		}](e.Data).TraceContext
		if v := telemetry.Parse(w); v.IsValid() {
			sc = v
		}
	}
	return
}

func (h *Harness) runTraced(ctx context.Context, p *turnPorts, t api.Turn, resume *api.Entry, snap api.Session, runtime api.Runtime) api.Outcome {
	attrs := []attribute.KeyValue{telemetry.String("gen_ai.operation.name", "invoke_agent")}
	if n := telemetry.Name(h.agentName); n != "" {
		attrs = append(attrs, telemetry.String("gen_ai.agent.name", n))
	}
	options := []trace.SpanStartOption{}
	if resume != nil {
		attrs = append(attrs, attribute.Bool("modular_agent.turn.resumed", true))
		if sc := savedTurn(snap, t.ID); sc.IsValid() {
			ctx = trace.ContextWithRemoteSpanContext(ctx, sc)
			options = append(options, trace.WithLinks(trace.Link{SpanContext: sc}))
		} else {
			options = append(options, trace.WithNewRoot())
		}
	} else if len(p.input.Calls) != 0 {
		for _, e := range snap.Branch() {
			if e.Kind == "turn.end" && e.Turn != "" {
				for _, old := range api.Decode[api.Outcome](e.Data).Open {
					for _, call := range p.input.Calls {
						if old.ID == call.ID {
							if sc := savedTurn(snap, e.Turn); sc.IsValid() {
								options = append(options, trace.WithLinks(trace.Link{SpanContext: sc}))
							}
						}
					}
				}
			}
		}
	}
	parent := ctx
	ctx, span := telemetry.Start(ctx, telemetry.Named("invoke_agent", h.agentName), append(options, trace.WithAttributes(attrs...))...)
	defer func() {
		outcome := "interrupted"
		p.s.mu.Lock()
		for _, e := range p.s.data.Entries[min(len(snap.Entries), len(p.s.data.Entries)):] {
			if e.Turn == t.ID && e.Kind == "turn.end" {
				outcome = api.Decode[api.Outcome](e.Data).Status
			}
		}
		p.s.mu.Unlock()
		span.SetAttributes(telemetry.String("modular_agent.turn.outcome", outcome))
		if outcome == "failed" || outcome == "interrupted" {
			telemetry.Failed(span, outcome)
		}
		span.End()
	}()
	if w := telemetry.Own(parent, span); w != nil && runtime.Declaration().Durable {
		ctx = context.WithValue(ctx, turnWireKey{}, w)
		if resume != nil {
			p.s.mu.Lock()
			_, err := p.s.recordLocked(api.Entry{Kind: telemetry.TurnTrace, Turn: t.ID, Data: api.JSON(map[string]any{"traceContext": w})}, "harness", true, ctx)
			p.s.mu.Unlock()
			if err != nil {
				return api.Outcome{Status: "failed", Error: err.Error()}
			}
		}
	}
	return runtime.Run(ctx, t)
}

func toolAttrs(call api.Call) []attribute.KeyValue {
	attrs := []attribute.KeyValue{telemetry.String("gen_ai.operation.name", "execute_tool"), telemetry.String("gen_ai.tool.name", telemetry.Name(call.Name)), telemetry.String("modular_agent.tool.call.id", call.ID)}
	if call.ParentCall != "" {
		attrs = append(attrs, telemetry.String("modular_agent.tool.parent_call.id", call.ParentCall))
	}
	if call.Reference != "" {
		attrs = append(attrs, telemetry.String("gen_ai.tool.call.id", call.Reference))
	} else if call.Origin == "model" {
		attrs = append(attrs, telemetry.String("gen_ai.tool.call.id", call.ID))
	}
	return attrs
}

func startTool(ctx context.Context, call api.Call) (context.Context, trace.Span) {
	attrs := toolAttrs(call)
	if a := telemetry.Agent(ctx); a.Value.AsString() != "" {
		attrs = append(attrs, a)
	}
	return telemetry.Start(telemetry.Step(ctx, call.Step), telemetry.Named("execute_tool", call.Name), trace.WithAttributes(attrs...))
}

func toolStatus(status string) string {
	switch status {
	case "unknown":
		return "outcomeUnknown"
	case "not_started":
		return "notStarted"
	case "completed", "failed", "cancelled", "refused", "pending", "outcomeUnknown", "notStarted":
		return status
	default:
		return "pending"
	}
}

func endTool(span trace.Span, result api.ToolResult, err error) {
	status := toolStatus(result.Status)
	span.SetAttributes(telemetry.String("modular_agent.tool.status", status))
	if status == "failed" || status == "outcomeUnknown" {
		telemetry.Failed(span, status)
	}
	telemetry.Finish(span, err)
}

func toolDisposition(ctx context.Context, call api.Call, status string) {
	telemetry.Event(ctx, "modular_agent.tool.disposition", append(toolAttrs(call), telemetry.String("modular_agent.tool.status", toolStatus(status)))...)
}

func (s *session) endJobSpan(id, status string) {
	if span := s.jobSpans[id]; span != nil {
		delete(s.jobSpans, id)
		span.SetAttributes(telemetry.String("modular_agent.job.outcome", status))
		if status == "failed" {
			telemetry.Failed(span, "failed")
		}
		span.End()
	}
}

func firstContext(contexts []context.Context) context.Context {
	if len(contexts) > 0 {
		return contexts[0]
	}
	return context.Background()
}

func saveHistory(ctx context.Context, lease api.Lease, next api.Session) error {
	if l, ok := lease.(interface {
		SaveContext(context.Context, api.Session) error
	}); ok {
		return l.SaveContext(context.WithoutCancel(ctx), next)
	}
	return lease.Save(next)
}

func (s *session) traceCommit(next api.Session, record bool, contexts []context.Context, save func(context.Context) error) (err error) {
	ctx := telemetry.Session(firstContext(contexts), next.ID)
	if !record {
		return save(ctx)
	}
	count := len(next.Entries) - len(s.data.Entries)
	if s.pendingStore != nil {
		count = len(next.Entries)
	}
	ctx, span := telemetry.Start(ctx, "modular_agent.history.commit", trace.WithAttributes(attribute.Int("modular_agent.history.entry.count", max(count, 0))))
	defer func() {
		status := "committed"
		if err != nil {
			status = "failed"
			if errors.Is(err, api.ErrWriterLost) {
				status = "uncertain"
			}
		}
		span.SetAttributes(telemetry.String("modular_agent.history.commit.status", status))
		telemetry.Finish(span, err)
	}()
	return save(ctx)
}
