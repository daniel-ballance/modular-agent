package acpinterface

import (
	"context"
	"encoding/json"

	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
)

func (s *server) workTrace(ctx context.Context, meta map[string]json.RawMessage) context.Context {
	if s.principal == nil || !s.principal.TrustTrace {
		return ctx
	}
	var parent string
	if json.Unmarshal(meta["traceparent"], &parent) != nil {
		return ctx
	}
	return telemetry.Extract(ctx, &telemetry.Wire{Parent: parent})
}

func (s *server) traceMeta(ctx context.Context, meta map[string]json.RawMessage) map[string]json.RawMessage {
	if s.principal == nil || !s.principal.TrustTrace {
		return meta
	}
	if w := telemetry.Inject(ctx); w != nil {
		if meta == nil {
			meta = make(map[string]json.RawMessage)
		}
		meta["traceparent"], _ = json.Marshal(w.Parent)
	}
	return meta
}
