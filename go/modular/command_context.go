package modular

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

func runSDKCommand(ctx context.Context, a api.API, server *pluginrpc.Server, plugin, id, actor string, command Command, args string, owner *jobAdapter) (string, error) {
	var active atomic.Bool
	ctx, cancel := context.WithCancel(ctx)
	active.Store(true)
	defer func() { active.Store(false); cancel() }()
	step := api.Executing(ctx).Step
	work := &ToolContext{SessionID: id, ActorID: actor, ctx: ctx, host: a, server: server, plugin: plugin, only: command.InProcessOnly}
	defer work.settled.Store(true)
	cx := &CommandContext{SessionID: id, ActorID: actor, StepID: step, active: &active, work: work, Jobs: JobCalls{work: work, jobs: owner}}
	cx.Environment.tc = work
	if server != nil {
		cx.Environment.port = server.HostEnvironment()
		cx.Environment.project = server.Project()
	} else {
		if snap, err := a.Snapshot(id); err == nil {
			cx.Environment.project = snap.Project
		}
		if env, err := a.Get("working-environment"); err == nil {
			cx.Environment.port = env.(api.WorkingEnvironment)
		}
	}
	if command.UsesModel && server == nil {
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

func (c *CommandContext) History(ctx context.Context, cursor ...string) (HistoryPage, error) {
	return c.work.History(ctx, cursor...)
}
func (c *CommandContext) Emit(ctx context.Context, kind string, data any) error {
	return c.work.Emit(ctx, kind, data)
}
func (c *CommandContext) Log(message string)         { c.work.Log(message) }
func (c *CommandContext) Cancelled() <-chan struct{} { return c.work.Cancelled() }
func (c *CommandContext) CallHook(ctx context.Context, name string, payload any) (any, error) {
	return callCustom(ctx, c.work, name, payload)
}

// Ask waits for an answer within this in-process command. A command cannot leave a call open.
func (c *CommandContext) Ask(ctx context.Context, q Question, options ...AskOptions) (Answer, error) {
	if len(options) > 1 || len(options) == 1 && options[0].Then == "leaveOpen" {
		return Answer{}, &Error{Code: InvalidRequest, Message: "commands cannot leave questions open"}
	}
	var answer Answer
	err := c.work.callback(ctx, func(ctx context.Context) error {
		if c.work.server != nil || !c.work.only {
			return &Error{Code: NotSupported, Message: "asking requires an in-process-only command"}
		}
		v, err := c.work.host.Get("questions")
		if err != nil {
			return err
		}
		ask := api.Question{Session: c.SessionID, Actor: c.ActorID, Step: c.StepID, Kind: q.Kind, Prompt: q.Question, Options: q.Options, Details: q.Details, Credential: q.Credential}
		if len(options) == 1 {
			ask.Wait = options[0].Wait
		}
		ans, err := v.(api.Questions).Ask(ctx, ask)
		var declined *api.QuestionDeclined
		if errors.As(err, &declined) {
			answer = Decline(declined.Reason)
			return nil
		}
		answer = Answer{Value: ans.Value, Declined: ans.Declined, Reason: ans.Reason, Stored: ans.Stored}
		return err
	})
	return answer, appError(err, InvalidRequest)
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
