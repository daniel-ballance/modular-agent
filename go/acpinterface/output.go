package acpinterface

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"math"
	"net/http"
	"slices"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func heldError(err error) error {
	var refusal *servicehttp.ResponseError
	if !errors.As(err, &refusal) || refusal.Status != http.StatusConflict || refusal.Code != "held" ||
		refusal.RetryAfterMS <= 0 || refusal.RetryAfterMS > 9007199254740991 || math.Trunc(refusal.RetryAfterMS) != refusal.RetryAfterMS {
		return nil
	}
	return &acp.RequestError{Code: -32000, Message: "Session writer is held", Data: map[string]any{"code": "held", "retryAfterMs": int64(refusal.RetryAfterMS)}}
}

func outputReplyError(err error) error {
	if errors.Is(err, api.ErrErasureUnavailable) {
		return acpError("unavailable")
	}
	if errors.Is(err, api.ErrErasureBusy) {
		return acpError("busy")
	}
	if errors.Is(err, api.ErrSessionLost) {
		return &acp.RequestError{Code: -32000, Message: api.ErrSessionLost.Error(), Data: map[string]string{"code": "lost"}}
	}
	if errors.Is(err, api.ErrSettingsBusy) || errors.Is(err, api.ErrCapacity) {
		return &acp.RequestError{Code: -32000, Message: err.Error(), Data: map[string]string{"code": "busy"}}
	}
	if errors.Is(err, api.ErrUnknownModel) {
		return acp.NewInvalidParams(map[string]any{"reason": err.Error()})
	}
	if errors.Is(err, api.ErrOutputWithheld) {
		// The original response and the handler's error both stay private.
		return &acp.RequestError{Code: -32000, Message: api.ErrOutputWithheld.Error(), Data: map[string]string{"code": "withheld"}}
	}
	return err
}

type outputGate interface {
	OutputValue(context.Context, api.Event) (api.Event, error)
}

func (s *server) historyView(ctx context.Context, session string) (api.Session, error) {
	if view, ok := s.a.(interface {
		ViewForOutput(context.Context, string) (api.Session, error)
	}); ok {
		return view.ViewForOutput(ctx, session)
	}
	return s.a.View(ctx, session)
}

func (s *server) gateAnswer(ctx context.Context, session, method string, result any) (any, error) {
	st, err := s.attached(session)
	if err != nil || !s.canDeliver(st, session, api.Acting(ctx)) {
		return nil, acpError("forbidden")
	}
	gate, ok := s.a.(outputGate)
	if !ok {
		return result, nil
	}
	event, err := gate.OutputValue(ctx, api.Event{Kind: "interface.answer", Method: method, Session: session, Data: api.JSON(result)})
	if err != nil {
		return nil, err
	}
	if !s.canDeliver(st, session, api.Acting(ctx)) {
		return nil, acpError("forbidden")
	}
	if !json.Valid(event.Data) {
		return nil, api.ErrOutputWithheld
	}
	if method == "_modular-agent/history" {
		type entryIdentity struct {
			ID, Kind                                                                                  string
			ParentID, TurnID, StepID, ToolCallID, JobID, ActorID, InputID, RequestID, ContinuesTurnID string
		}
		type historyIdentity struct {
			Entries     []entryIdentity
			NextEntryID string
		}
		before := api.Decode[historyIdentity](api.JSON(result))
		after := api.Decode[historyIdentity](event.Data)
		if before.NextEntryID != after.NextEntryID || !slices.Equal(before.Entries, after.Entries) {
			return nil, api.ErrOutputWithheld
		}
	}
	return event.Data, nil
}
