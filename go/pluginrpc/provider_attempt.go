package pluginrpc

import (
	"context"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Each provider/request has its own grant and raw response. Neither the
// Runtime nor the Provider can reuse a grant from a different RPC parent.
type providerAttempt struct {
	mu                           sync.Mutex
	fence                        api.FinalModelDispatch
	request                      object
	requested, granted, answered bool
	response                     object
}

func (a *providerAttempt) hook(ctx context.Context, h *host, hook string, payload object) (any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if hook == "provider.response" {
		payload = providerResponsePayload(payload, asObject(payload["message"]))
		if !a.granted || a.answered || str(asObject(payload["message"]), "role") != "assistant" {
			return nil, fault("invalid_request", "Provider response has no active dispatch grant")
		}
		a.response = asObject(payload["message"])
		a.answered = true
		_, err := h.h.API().Invoke(ctx, hookNames[hook], payload)
		return nil, err
	}
	if a.requested || !sameJSON(a.request, payload["request"]) {
		return nil, fault("invalid_request", "Provider request hook must echo the original request once")
	}
	a.requested = true
	final := payload
	if !a.fence.Replay {
		changed, err := h.h.API().Invoke(ctx, hookNames[hook], payload)
		if err != nil {
			return nil, err
		}
		final = asObject(changed)
	}
	if has(final, "refused") {
		return nil, fault("refused", str(final, "refused"))
	}
	if a.fence.Commit != nil {
		if err := a.fence.Commit(ctx, requestIn(asObject(final["request"]))); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a.granted = true
	return final, nil
}

func (a *providerAttempt) canStream() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.granted && !a.answered
}

func (a *providerAttempt) matches(msg object) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.granted && a.answered && sameJSON(a.response, msg)
}

func providerResponsePayload(p object, message object) object {
	return object{"sessionId": p["sessionId"], "provider": p["provider"], "model": p["model"], "message": message}
}

func answerValue(r api.Response) object {
	if len(r.Wire) != 0 {
		return obj(r.Wire)
	}
	return responseOut(r)
}

func requestValue(r api.Request) object {
	if len(r.Wire) != 0 {
		return obj(r.Wire)
	}
	return requestOut(r)
}
