package modular

import (
	"context"
	"strings"
	"sync/atomic"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

func runSDKCommand(ctx context.Context, a api.API, id string, command Command, args string) (string, error) {
	var active atomic.Bool
	ctx, cancel := context.WithCancel(ctx)
	active.Store(true)
	defer func() { active.Store(false); cancel() }()
	cx := &CommandContext{SessionID: id, ActorID: api.Acting(ctx), StepID: api.Executing(ctx).Step, active: &active}
	if command.UsesModel {
		cx.requestModel = func(other context.Context, req ModelRequest) (AssistantMessage, error) {
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			stop := context.AfterFunc(other, cancel)
			defer stop()
			if err := other.Err(); err != nil {
				return AssistantMessage{}, appError(err, CancelledCode)
			}
			var request portable.Object
			if err := decodeInto(req, &request); err != nil {
				return AssistantMessage{}, appError(err, InvalidRequest)
			}
			for _, m := range req.Messages {
				if len(m.ProviderData) != 0 {
					return AssistantMessage{}, &Error{Code: InvalidRequest, Message: "command cannot supply opaque Provider data"}
				}
			}
			access := a.(interface {
				RequestCommandModel(context.Context, string, string, api.Request) (api.Response, error)
			})
			response, err := access.RequestCommandModel(ctx, cx.SessionID, cx.StepID, portable.ReadRequest(request))
			if err != nil {
				return AssistantMessage{}, appError(err, InvalidRequest)
			}
			var out AssistantMessage
			err = decodeInto(portable.Response(response), &out)
			return out, err
		}
	}
	return command.Run(ctx, strings.TrimSpace(args), cx)
}

// RequestModel makes one auxiliary request using the session's selected model.
func (c *CommandContext) RequestModel(ctx context.Context, request ModelRequest) (AssistantMessage, error) {
	if c.active != nil && !c.active.Load() {
		return AssistantMessage{}, &Error{Code: InvalidRequest, Message: "command context has settled"}
	}
	if c.requestModel == nil {
		return AssistantMessage{}, &Error{Code: NotSupported, Message: "requesting a model requires an in-process UsesModel command"}
	}
	return c.requestModel(ctx, request)
}
