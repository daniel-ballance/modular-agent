// Package telemetry records metadata only. It never installs an OpenTelemetry SDK.
package telemetry

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const scope = "modular-agent"
const TurnTrace = "modular-agent.turnTrace"

type scopeKey struct{}
type work struct{ session, turn, step, agent string }

func Scope(ctx context.Context, session, turn, step, agent string) context.Context {
	return context.WithValue(ctx, scopeKey{}, work{session, turn, step, agent})
}

func Session(ctx context.Context, id string) context.Context {
	w, _ := ctx.Value(scopeKey{}).(work)
	if w.session == id {
		return ctx
	}
	return Scope(ctx, id, "", "", w.agent)
}

func Step(ctx context.Context, id string) context.Context {
	w, _ := ctx.Value(scopeKey{}).(work)
	if id == "" || w.step == id {
		return ctx
	}
	return Scope(ctx, w.session, w.turn, id, w.agent)
}

func Agent(ctx context.Context) attribute.KeyValue {
	w, _ := ctx.Value(scopeKey{}).(work)
	return attribute.String("gen_ai.agent.name", Name(w.agent))
}

func String(key, value string) attribute.KeyValue { return attribute.String(key, value) }

func Start(ctx context.Context, name string, options ...trace.SpanStartOption) (context.Context, trace.Span) {
	w, _ := ctx.Value(scopeKey{}).(work)
	attrs := []attribute.KeyValue{}
	if w.session != "" {
		attrs = append(attrs, String("gen_ai.conversation.id", w.session))
	}
	if w.turn != "" {
		attrs = append(attrs, String("modular_agent.turn.id", w.turn))
	}
	if w.step != "" {
		attrs = append(attrs, String("modular_agent.step.id", w.step))
	}
	return otel.Tracer(scope).Start(ctx, name, append(options, trace.WithAttributes(attrs...))...)
}

// Name accepts identifier-shaped metadata, never paths or free text. Callers
// supply only names from registration or explicit configuration.
func Name(value string) string {
	if len(value) > 128 {
		return ""
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.:@", c)) {
			return ""
		}
	}
	return value
}

func Named(operation, name string) string {
	if name = Name(name); name != "" {
		return operation + " " + name
	}
	return operation
}

func Failed(span trace.Span, kind string) {
	span.SetAttributes(String("error.type", kind))
	span.SetStatus(codes.Error, "")
}

func Finish(span trace.Span, err error) {
	if err != nil && !errors.Is(err, context.Canceled) {
		Failed(span, "failed")
	}
	span.End()
}

func Event(ctx context.Context, name string, attrs ...attribute.KeyValue) {
	trace.SpanFromContext(ctx).AddEvent(name, trace.WithAttributes(attrs...))
}

// Only traceparent is emitted. There is no configured allowlist for vendor
// state, so neither tracestate nor baggage crosses a trust boundary.
type Wire struct {
	Parent string `json:"traceparent"`
}

func Inject(ctx context.Context) *Wire {
	c := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, c)
	if p := c.Get("traceparent"); p != "" {
		return &Wire{Parent: p}
	}
	return nil
}

func Parse(w *Wire) trace.SpanContext {
	if w == nil {
		return trace.SpanContext{}
	}
	return trace.SpanContextFromContext(propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier{"traceparent": w.Parent}))
}

// InTrace keeps a supplied operation only in the tracked work's trace.
// Retain the caller's cancellation, but restore the tracked work's IDs.
func InTrace(ctx, tracked context.Context) context.Context {
	if tracked == nil {
		return ctx
	}
	parent := trace.SpanFromContext(tracked)
	if candidate := trace.SpanFromContext(ctx); candidate.SpanContext().IsValid() && candidate.SpanContext().TraceID() == parent.SpanContext().TraceID() {
		parent = candidate
	}
	if scope, ok := tracked.Value(scopeKey{}).(work); ok {
		ctx = context.WithValue(ctx, scopeKey{}, scope)
	}
	return trace.ContextWithSpan(ctx, parent)
}

func Extract(ctx context.Context, w *Wire) context.Context {
	if sc := Parse(w); sc.IsValid() {
		return trace.ContextWithRemoteSpanContext(ctx, sc)
	}
	return ctx
}

func Own(ctx context.Context, span trace.Span) *Wire {
	// The API no-op implementation returns the parent itself, not a new span.
	if sc := span.SpanContext(); sc.IsValid() && sc.SpanID() != trace.SpanContextFromContext(ctx).SpanID() {
		return Inject(trace.ContextWithSpan(ctx, span))
	}
	return nil
}

func Inference(ctx context.Context, provider, model string, internal bool, stream ...bool) (context.Context, func(error, string, int, int)) {
	provider = Name(provider)
	model = Name(model)
	vendor := provider
	switch provider {
	case "anthropic":
		vendor = "anthropic"
	case "openai":
		vendor = "openai"
	case "openrouter":
		vendor = "openrouter"
	}
	dims := []attribute.KeyValue{String("gen_ai.operation.name", "chat"), String("gen_ai.provider.name", vendor)}
	if model != "" {
		dims = append(dims, String("gen_ai.request.model", model))
	}
	attrs := append(append([]attribute.KeyValue{}, dims...), String("modular_agent.provider.id", provider))
	if len(stream) != 0 {
		attrs = append(attrs, attribute.Bool("gen_ai.request.stream", stream[0]))
	}
	k := trace.SpanKindClient
	if internal {
		k = trace.SpanKindInternal
	}
	start := time.Now()
	ctx, span := Start(ctx, Named("chat", model), trace.WithSpanKind(k), trace.WithAttributes(attrs...))
	return ctx, func(err error, stop string, input, output int) {
		if (err != nil && !errors.Is(err, context.Canceled)) || stop == "failed" {
			Failed(span, "inference_failed")
			dims = append(dims, String("error.type", "inference_failed"))
		}
		switch stop {
		case "finished", "tools", "output_limit", "failed", "refused", "aborted":
			span.SetAttributes(attribute.StringSlice("gen_ai.response.finish_reasons", []string{stop}))
		}
		m := otel.Meter(scope)
		if h, e := m.Float64Histogram("gen_ai.client.inference.duration", metric.WithUnit("s")); e == nil {
			h.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(dims...))
		}
		tokenDims := append(dims, String("gen_ai.token.modality", "unknown"))
		record := func(which string, n int) {
			if n <= 0 {
				return
			}
			span.SetAttributes(attribute.Int("gen_ai.usage."+which+"_tokens", n))
			if c, e := m.Int64Counter("gen_ai.client.inference.usage."+which+"_tokens", metric.WithUnit("{token}")); e == nil {
				c.Add(ctx, int64(n), metric.WithAttributes(tokenDims...))
			}
		}
		record("input", input)
		record("output", output)
		span.End()
	}
}
