package pluginrpc

import (
	"context"
	"encoding/json"

	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"go.opentelemetry.io/otel/trace"
)

type traceHandshakeKey struct{}

// WithoutTraceHandshake disables the local handshake member for a compatibility check.
func WithoutTraceHandshake(ctx context.Context) context.Context {
	return context.WithValue(ctx, traceHandshakeKey{}, true)
}

func offersTraceContext(ctx context.Context) bool { return ctx.Value(traceHandshakeKey{}) != true }

func traceWork(method string) bool {
	switch method {
	case "runtime/runTurn", "runtime/resumeTurn", "runtime/continueOpenCalls",
		"provider/models", "provider/available", "provider/request", "provider/discard", "provider/event",
		"tools/list", "tools/call", "tools/progress", "tools/changed",
		"env/read", "env/write", "env/list", "env/exists", "env/exec", "env/output", "env/sessionEnded", "env/save", "env/checkPoint", "env/restore",
		"hook/handle", "command/run", "jobs/cancel", "jobs/resume",
		"host/hook", "host/ask", "host/emit", "host/history", "host/session",
		"host/tools/list", "host/tools/call", "host/env/read", "host/env/write", "host/env/list", "host/env/exists", "host/env/exec", "host/env/output",
		"host/jobs/start", "host/jobs/end", "host/jobs/list", "host/jobs/unfinished", "host/jobs/progress", "host/jobs/resume",
		"host/runtime/definition", "host/runtime/hasSteering", "host/runtime/newId", "host/runtime/prepareStep",
		"host/runtime/history", "host/runtime/model", "host/runtime/modelEvent", "host/runtime/record", "host/runtime/hook", "host/runtime/report", "host/runtime/runToolCall", "host/runtime/id", "host/runtime/takeSteering":
		return true
	}
	return false
}

func traceParams(raw json.RawMessage, ctx context.Context, agreed bool) json.RawMessage {
	var v map[string]json.RawMessage
	if json.Unmarshal(raw, &v) != nil || v == nil {
		return raw
	}
	if w := telemetry.Inject(ctx); agreed && w != nil {
		v["traceContext"] = mustJSON(w)
	} else {
		if _, ok := v["traceContext"]; !ok {
			return raw
		}
		delete(v, "traceContext")
	}
	return mustJSON(v)
}

func readTrace(raw json.RawMessage) *telemetry.Wire {
	var v struct {
		TraceContext *telemetry.Wire `json:"traceContext"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return v.TraceContext
}

func tracePlugin(ctx context.Context, name, method string, k trace.SpanKind) (context.Context, trace.Span) {
	return telemetry.Start(ctx, "modular_agent.plugin.request", trace.WithSpanKind(k), trace.WithAttributes(telemetry.String("modular_agent.plugin.name", telemetry.Name(name)), telemetry.String("modular_agent.plugin.method", method)))
}

func (p *Peer) receivedTrace(ctx context.Context, method string, raw json.RawMessage) context.Context {
	if !traceWork(method) {
		return ctx
	}
	if p.traceHost {
		parent := capturedParent(ctx)
		if !parent.ok || !p.traceAgreed.Load() {
			return ctx
		}
		scope := trace.SpanContextFromContext(parent.ctx)
		if incoming := telemetry.Parse(readTrace(raw)); incoming.IsValid() && scope.TraceID() == incoming.TraceID() {
			parent.ctx = trace.ContextWithRemoteSpanContext(parent.ctx, incoming)
			return context.WithValue(ctx, incomingParentKey{}, parent)
		}
		return ctx
	}
	if p.traceAgreed.Load() {
		return telemetry.Extract(ctx, readTrace(raw))
	}
	return ctx
}
