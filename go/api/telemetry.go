package api

import (
	"context"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
)

// ObserveInference covers the Harness's call to a Provider, not history replay.
func ObserveInference(ctx context.Context, access ModelAccess, request Request, emit func(Part)) (res Response, err error) {
	m := access.Model()
	id := strings.TrimPrefix(m.ID, m.Provider+"/")
	internal := m.Provider == "fake" || m.Provider == "conformance" || m.Provider == "script"
	ctx, end := telemetry.Inference(ctx, m.Provider, id, internal)
	defer func() { end(err, res.Stop, res.Usage.Input, res.Usage.Output) }()
	return access.Generate(ctx, request, emit)
}
