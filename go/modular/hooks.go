package modular

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

// HookPayload is the shared payload for a binding hook. The point-specific
// registration methods offer typed payloads for common hooks.
type HookPayload map[string]any

// HookAnswer is a binding hook answer. Return nil to pass. Gate handlers
// return {"refuse": reason}; transforms return {"value": changedPayload}.
type HookAnswer map[string]any

// On registers a standard hook using the binding's shared payload and answer.
// Use the typed OnToolBefore and OnToolAfter methods for tool gates and results.
func (r *Registrar) On(point string, fn func(context.Context, HookPayload) (HookAnswer, error), opts ...HookOption) error {
	if (!pluginrpc.IsHook(point) && !strings.Contains(point, ".")) || fn == nil {
		return r.fail(&Error{Code: InvalidParams, Message: "unknown hook or missing handler: " + point})
	}
	return r.on(hookRegistration{point: point, only: !pluginrpc.IsHook(point), handle: func(ctx context.Context, p pluginrpc.Object) (any, error) {
		var payload HookPayload
		decoder := json.NewDecoder(bytes.NewReader(api.JSON(p)))
		decoder.UseNumber()
		if err := decoder.Decode(&payload); err != nil {
			return nil, err
		}
		ans, err := fn(ctx, payload)
		if err != nil || ans == nil {
			return nil, err
		}
		// Return an ordinary object: in-process handlers use the same adapter
		// as a JSON reply from a served handler.
		return pluginrpc.Object(ans), nil
	}}, opts)
}

type SessionStart struct {
	SessionID string `json:"sessionId"`
	Resumed   bool   `json:"resumed"`
}

func (r *Registrar) OnSessionStart(fn func(context.Context, SessionStart) error, opts ...HookOption) error {
	return r.On("session.start", func(ctx context.Context, payload HookPayload) (HookAnswer, error) {
		var start SessionStart
		if err := decodeInto(payload, &start); err != nil {
			return nil, err
		}
		return nil, fn(ctx, start)
	}, opts...)
}

type ProviderRequest struct {
	SessionID string       `json:"sessionId"`
	Provider  string       `json:"provider"`
	Model     ModelRef     `json:"model"`
	Request   ModelRequest `json:"request"`
}

type ProviderResponse struct {
	SessionID string           `json:"sessionId"`
	Provider  string           `json:"provider"`
	Model     ModelRef         `json:"model"`
	Message   AssistantMessage `json:"message"`
}

// OnProviderRequest sees the original request. A non-nil return replaces
// the model request while preserving the session and Provider identities.
func (r *Registrar) OnProviderRequest(fn func(context.Context, ProviderRequest) (*ModelRequest, error), opts ...HookOption) error {
	return r.On("provider.request", func(ctx context.Context, payload HookPayload) (HookAnswer, error) {
		var in ProviderRequest
		if err := decodeInto(payload, &in); err != nil {
			return nil, err
		}
		changed, err := fn(ctx, in)
		if err != nil || changed == nil {
			return nil, err
		}
		// Keep top-level fields the typed request does not know.
		var request map[string]json.RawMessage
		if err := decodeInto(payload["request"], &request); err != nil {
			return nil, err
		}
		var fields map[string]json.RawMessage
		if err := decodeInto(changed, &fields); err != nil {
			return nil, err
		}
		for k, v := range fields {
			request[k] = v
		}
		payload["request"] = request
		return HookAnswer{"value": payload}, nil
	}, opts...)
}

func (r *Registrar) OnProviderResponse(fn func(context.Context, ProviderResponse) error, opts ...HookOption) error {
	return r.On("provider.response", func(ctx context.Context, payload HookPayload) (HookAnswer, error) {
		var response ProviderResponse
		if err := decodeInto(payload, &response); err != nil {
			return nil, err
		}
		return nil, fn(ctx, response)
	}, opts...)
}
