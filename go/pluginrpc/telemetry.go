package pluginrpc

import (
	"context"

	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"go.opentelemetry.io/otel/trace"
)

func (w *runtimeWork) traceStep(ctx context.Context, step string) context.Context {
	if step == "" || w.traceTurn == nil {
		return ctx
	}
	w.traceMu.Lock()
	defer w.traceMu.Unlock()
	sc := w.traceSteps[step]
	if sc == nil {
		sc, _ = telemetry.Start(telemetry.Step(w.traceTurn, step), "modular_agent.step")
		if w.traceSteps == nil {
			w.traceSteps = make(map[string]context.Context)
		}
		w.traceSteps[step] = sc
	}
	return trace.ContextWithSpan(telemetry.Step(ctx, step), trace.SpanFromContext(sc))
}

func (w *runtimeWork) endTraceSteps() {
	w.traceMu.Lock()
	defer w.traceMu.Unlock()
	for _, sc := range w.traceSteps {
		trace.SpanFromContext(sc).End()
	}
}
