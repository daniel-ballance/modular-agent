package modular

import (
	"context"
	"errors"
	"io/fs"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
)

type Code string

const (
	InvalidParams      Code = "invalid_params"
	InvalidRequest     Code = "invalid_request"
	InvalidComposition Code = "invalid_composition"
	Forbidden          Code = "forbidden"
	NotFound           Code = "not_found"
	NotOpen            Code = "not_open"
	Busy               Code = "busy"
	Held               Code = "held"
	Conflict           Code = "conflict"
	CancelledCode      Code = "cancelled"
	NotSupported       Code = "not_supported"
	TurnLimit          Code = "turn_limit"
	Unavailable        Code = "unavailable"
	UnknownHandler     Code = "unknown_handler"
	Withheld           Code = "withheld"
	ResultTooLarge     Code = "result_too_large"
	MessageTooLarge    Code = "message_too_large"
	Lost               Code = "lost"
	Internal           Code = "internal"
)

type Error struct {
	Code    Code           `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

func appError(err error, fallback Code) error {
	if err == nil {
		return nil
	}
	var sdk *Error
	var rpc *pluginrpc.RPCError
	var remote *servicehttp.ResponseError
	switch {
	case errors.As(err, &sdk):
		return sdk
	case errors.Is(err, api.ErrSessionLost):
		return &Error{Code: Lost, Message: api.ErrSessionLost.Error()}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		fallback = CancelledCode
	case errors.Is(err, api.ErrErasureUnavailable):
		fallback = Unavailable
	case errors.Is(err, api.ErrErasureUnsupported):
		fallback = NotSupported
	case errors.Is(err, api.ErrErasureBusy):
		fallback = Busy
	case errors.Is(err, api.ErrResultTooLarge):
		fallback = ResultTooLarge
	case errors.Is(err, api.ErrCapacity):
		fallback = Busy
	case errors.Is(err, api.ErrAuthority), errors.Is(err, api.ErrTenantForbidden):
		fallback = Forbidden
	case errors.Is(err, fs.ErrNotExist):
		fallback = NotFound
	case errors.As(err, &remote) && remote.Code != "":
		e := &Error{Code: Code(remote.Code), Message: remote.Error()}
		if e.Code == Held {
			e.Data = map[string]any{"retryAfterMs": remote.RetryAfterMS}
		}
		return e
	case errors.As(err, &rpc):
		e := &Error{Code: Code(rpc.Data.Code), Message: rpc.Message}
		if e.Code == TurnLimit && rpc.Data.Limit != "" {
			e.Data = map[string]any{"limit": rpc.Data.Limit}
		}
		return e
	}
	return &Error{Code: fallback, Message: err.Error()}
}
