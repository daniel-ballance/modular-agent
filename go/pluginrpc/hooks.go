package pluginrpc

import (
	"context"
	"errors"
	"modular/api"
)

var hookNames = map[string]string{
	"output":      "output.batch",
	"plugin.load": "plugin.load", "session.start": "session.start", "session.end": "session.end", "input": "input", "turn.before": "binding.turn.before", "turn.start": "runtime.turn.start", "step.before": "runtime.step.before", "step.after": "runtime.step.after", "tool.before": "runtime.tool.before", "tool.after": "runtime.tool.after", "model.failed": "runtime.request.failed", "turn.result": "runtime.result", "turn.end": "runtime.turn.end", "provider.request": "binding.provider.request", "provider.response": "binding.provider.response",
}

func (h *host) plugin() api.Plugin {
	return api.Plugin{Name: "stdio-host", Setup: func(a api.API) error {
		h.a = a
		if err := a.Provide("job-owner-lookup", api.JobOwnerLookup(h.jobCanceller)); err != nil {
			return err
		}
		if err := a.Provide("job-owner-present", func(name string) bool { return h.jobOwner(name) != nil }); err != nil {
			return err
		}
		if err := h.h.WrapProviders(func(id string, p api.Provider) api.Provider { return &localProvider{host: h, Provider: p, id: id} }); err != nil {
			return err
		}
		for name, rule := range map[string]api.Rule{"binding.turn.before": api.Collect, "binding.provider.request": api.Transform, "binding.provider.response": api.Observe} {
			if err := a.Define(name, rule); err != nil {
				return err
			}
		}
		return a.Handle("turn.prepare", "last", func(ctx context.Context, v any) (api.Decision, error) {
			before := v.(api.BeforeTurn)
			payload := object{"sessionId": before.Session.ID, "turnId": before.Turn, "input": contentOut(before.Input)}
			value, err := a.Invoke(ctx, "binding.turn.before", payload)
			if err != nil {
				return api.Decision{}, err
			}
			for _, contribution := range value.([]any) {
				c := asObject(contribution)
				if str(c, "system") != "" {
					before.System += "\n" + str(c, "system")
				}
				before.Context = append(before.Context, contentIn(c["context"])...)
			}
			return api.Decision{Value: before}, nil
		})
	}}
}
func (r *remote) handler(reg HookRegistration) api.Handler {
	return func(ctx context.Context, v any) (api.Decision, error) {
		if reg.Hook == "output" {
			return r.outputHandler(ctx, reg.ID, v.(api.OutputBatch))
		}
		payload := r.hookPayload(ctx, reg.Hook, v)
		actor := api.Acting(ctx)
		session := str(payload, "sessionId")
		if reg.Hook == "input" {
			actor = v.(api.InputEvent).Input.Actor
		}
		if reg.Hook == "tool.before" {
			actor = v.(api.ToolCheck).Call.Actor
		}
		if reg.Hook == "tool.after" {
			actor = v.(api.AfterTool).Call.Actor
		}
		w := work{session: session, actor: actor}
		if x, ok := v.(api.ToolCheck); ok {
			w.call = x.Call
		}
		if x, ok := v.(api.AfterTool); ok {
			w.call = x.Call
		}
		var answer any
		err := r.call(withWork(ctx, w), "hook/handle", object{"handlerId": reg.ID, "hook": reg.Hook, "payload": payload}, &answer)
		if err != nil {
			return api.Decision{}, err
		}
		if answer == nil {
			return api.Decision{}, nil
		}
		result := asObject(answer)
		switch reg.Hook {
		case "plugin.load", "tool.before":
			if has(result, "pending") {
				return api.Decision{}, api.ErrQuestionOpen
			}
			if has(result, "refuse") {
				return api.Decision{}, errors.New(str(result, "refuse"))
			}
			if has(result, "change") {
				if reg.Hook == "plugin.load" {
					return api.Decision{}, nil
				}
				check := v.(api.ToolCheck)
				changed := callIn(asObject(asObject(result["change"])["call"]))
				check.Call.Input = changed.Input
				check.Call.Wire = changed.Wire
				return api.Decision{Value: check}, nil
			}
		case "step.after":
			if reason := str(result, "refuse"); reason != "" {
				return api.Decision{}, errors.New(reason)
			}
			return api.Decision{}, errors.New("invalid step.after decision")
		case "turn.result":
			if has(result, "refuse") {
				check := v.(api.ResultCheck)
				check.Continue = str(result, "refuse")
				return api.Decision{Value: check, Stop: true}, nil
			}
			if has(result, "change") {
				check := v.(api.ResultCheck)
				check.Result = api.Text(str(asObject(asObject(result["change"])["result"]), "text"))
				return api.Decision{Value: check}, nil
			}
		case "turn.before":
			return api.Decision{Value: answer}, nil
		case "model.failed":
			if boolean(result, "retry") {
				f := v.(api.Failure)
				f.Retry = true
				if has(result, "request") {
					f.Context.Request = requestIn(asObject(result["request"]))
				}
				return api.Decision{Answer: true, Value: f}, nil
			}
		case "input", "step.before", "tool.after", "provider.request":
			if !has(result, "value") {
				return api.Decision{}, nil
			}
			changed := asObject(result["value"])
			var value any
			switch reg.Hook {
			case "input":
				e := v.(api.InputEvent)
				e.Input.Content = contentIn(changed["content"])
				if when := str(changed, "when"); when != "" {
					if when != "now" && when != "steer" && when != "after" {
						return api.Decision{}, fault("invalid_request", "invalid transformed intake timing")
					}
					e.Input.When = when
				}
				if boolean(result, "stop") {
					e.Handled = true
				}
				value = e
			case "step.before":
				e := v.(api.StepContext)
				e.Request = requestIn(asObject(changed["request"]))
				value = e
			case "tool.after":
				e := v.(api.AfterTool)
				e.Result = resultIn(asObject(changed["result"]))
				value = e
			case "provider.request":
				value = changed
			}
			return api.Decision{Value: value, Stop: boolean(result, "stop")}, nil
		}
		return api.Decision{}, nil
	}
}
func (r *remote) hookPayload(ctx context.Context, hook string, v any) object {
	execution := api.Executing(ctx)
	payload := object{"sessionId": execution.Session, "turnId": execution.Turn}
	switch hook {
	case "plugin.load":
		return object{"name": v, "origin": "configuration", "project": r.host.project}
	case "session.start":
		s := v.(api.Session)
		return object{"sessionId": s.ID, "resumed": len(s.Entries) > 0}
	case "session.end":
		return object{"sessionId": v}
	case "input":
		e := v.(api.InputEvent)
		return object{"sessionId": e.Session, "actorId": e.Input.Actor, "content": contentOut(e.Input.Content), "when": e.Input.When}
	case "turn.before", "provider.request", "provider.response":
		return asObject(v)
	case "turn.start":
		t := v.(api.Turn)
		return object{"sessionId": t.Session, "turnId": t.ID}
	case "step.before":
		s := v.(api.StepContext)
		return object{"sessionId": s.Turn.Session, "turnId": s.Turn.ID, "stepId": s.Step, "model": modelOut(s.Turn.Access.Model()), "request": requestOut(s.Request)}
	case "step.after":
		payload["stepId"] = v.(api.AfterStep).Step
		payload["response"] = responseOut(v.(api.AfterStep).Response)
	case "tool.before":
		c := v.(api.ToolCheck)
		return object{"sessionId": c.Session, "turnId": c.Turn, "call": callOut(c.Call), "definition": toolOut(c.Definition)}
	case "tool.after":
		e := v.(api.AfterTool)
		payload["call"] = callOut(e.Call)
		payload["result"] = resultOut(e.Result)
	case "model.failed":
		f := v.(api.Failure)
		return object{"sessionId": f.Context.Turn.Session, "request": requestOut(f.Context.Request), "error": errorOut(f.Err)}
	case "turn.result":
		payload["result"] = object{"text": v.(api.ResultCheck).Result.Text()}
	case "turn.end":
		o := v.(api.Outcome)
		payload["outcome"] = object{"kind": o.Status}
		if o.Error != "" {
			payload["outcome"].(object)["error"] = o.Error
		}
	}
	return payload
}
