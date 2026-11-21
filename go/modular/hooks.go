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
		request, err := changedRequest(payload["request"], *changed)
		if err != nil {
			return nil, err
		}
		payload["request"] = request
		return HookAnswer{"value": payload}, nil
	}, opts...)
}

// Keep opaque fields and the exact encodings of fields the handler did not change.
func changedRequest(raw any, changed ModelRequest) (map[string]json.RawMessage, error) {
	var original ModelRequest
	var request, before, after map[string]json.RawMessage
	if err := decodeInto(raw, &original); err != nil {
		return nil, err
	}
	if err := decodeInto(raw, &request); err != nil {
		return nil, err
	}
	if err := decodeInto(original, &before); err != nil {
		return nil, err
	}
	if err := decodeInto(changed, &after); err != nil {
		return nil, err
	}
	// Use original wire definitions for retained unedited tools, even on reorder.
	if !bytes.Equal(before["tools"], after["tools"]) {
		var originalTools []json.RawMessage
		_ = json.Unmarshal(request["tools"], &originalTools)
		tools := []json.RawMessage{}
		for _, def := range changed.Tools {
			encoded := api.JSON(def)
			for i, old := range original.Tools {
				if i < len(originalTools) && bytes.Equal(encoded, api.JSON(old)) {
					encoded = originalTools[i]
					break
				}
			}
			tools = append(tools, encoded)
		}
		request["tools"] = api.JSON(tools)
	}
	for k, v := range after {
		if k != "tools" && !bytes.Equal(v, before[k]) {
			request[k] = v
		}
	}
	for k := range before {
		if _, ok := after[k]; !ok {
			delete(request, k)
		}
	}
	return request, nil
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
