package api

import (
	"context"
	"go.opentelemetry.io/otel/attribute"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
)

// ObserveInference covers the Harness's call to a Provider, not history replay.
func ObserveInference(ctx context.Context, access ModelAccess, request Request, emit func(Part)) (res Response, err error) {
	m := access.Model()
	id := strings.TrimPrefix(m.ID, m.Provider+"/")
	internal := m.Provider == "fake" || m.Provider == "conformance" || m.Provider == "scripted"
	ctx, end := telemetry.Inference(ctx, m.Provider, id, internal)
	defer func() { end(err, res.Stop, res.Usage.Input, res.Usage.Output) }()
	return access.Generate(ctx, request, emit)
}

// ObserveToolDisposition records a decision without a dispatch span.
func ObserveToolDisposition(ctx context.Context, c Call, status string) {
	switch status {
	case "open":
		status = "pending"
	case "unknown":
		status = "outcomeUnknown"
	case "not_started":
		status = "notStarted"
	}
	attrs := []attribute.KeyValue{telemetry.String("modular_agent.tool.call.id", c.ID), telemetry.String("modular_agent.tool.status", status)}
	if name := telemetry.Name(c.Name); name != "" {
		attrs = append(attrs, telemetry.String("gen_ai.tool.name", name))
	}
	if c.Reference != "" {
		attrs = append(attrs, telemetry.String("gen_ai.tool.call.id", c.Reference))
	} else if c.Origin == "model" {
		attrs = append(attrs, telemetry.String("gen_ai.tool.call.id", c.ID))
	}
	telemetry.Event(ctx, "modular_agent.tool.disposition", attrs...)
}
