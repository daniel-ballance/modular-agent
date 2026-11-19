package pluginrpc

import (
	"context"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

func (w *runtimeWork) hook(ctx context.Context, hook string, p object) (any, error) {
	t := w.turn
	if (has(p, "sessionId") && str(p, "sessionId") != t.Session) || (has(p, "turnId") && str(p, "turnId") != t.ID) {
		return nil, fault("invalid_request", "hook scope differs from parent")
	}
	p["sessionId"], p["turnId"] = t.Session, t.ID
	if hook == "tool.before" {
		return w.beforeTool(ctx, p)
	}
	if hook == "model.failed" {
		return w.attemptFailure(ctx, p)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ending {
		return nil, fault("invalid_request", "Runtime turn has ended")
	}
	invoke := func(v any) (any, error) { return t.IO.Hook(ctx, hookNames[hook], v) }
	gate := object{"value": p}
	switch hook {
	case "turn.start":
		if t.Resume {
			// The original turn already started. Older Runtimes can observe
			// the resumed request without replaying the host's observers.
			return nil, nil
		}
		if w.started || w.active != nil || w.prepared != nil {
			return nil, fault("invalid_request", "turn.start is out of phase")
		}
		w.started = true
		_, err := invoke(t)
		return nil, err
	case "turn.end":
		o := outcomeIn(p)
		if (!w.boundary() || w.resultRefused) && o.Status == "completed" {
			return nil, fault("invalid_request", "turn.end is outside a settlement boundary")
		}
		w.applyOutcome(&o)
		w.ending = true
		_, err := invoke(o)
		return nil, err
	case "step.after":
		step := str(p, "stepId")
		a := w.responses[step]
		if a == nil || a.response.ID == "" || !sameJSON(a.answer, p["response"]) {
			return nil, fault("invalid_request", "step.after requires the committed response")
		}
		if a.after {
			if a.stepDecision.Refused != "" {
				gate["refused"] = a.stepDecision.Refused
			}
			return gate, nil
		}
		if a != w.active {
			return nil, fault("invalid_request", "step.after is out of phase")
		}
		for id := range w.committed {
			if w.calls[id].Step == a.step && w.terminals[id].ID == "" && !w.pending[id] {
				return nil, fault("invalid_request", "tool round is not settled")
			}
		}
		after := api.AfterStep{Step: a.step, Response: responseIn(a.answer)}
		changed, err := invoke(after)
		state := portable.StepAfter{Response: a.response, Committed: true}
		if err != nil {
			state.Refused = err.Error()
		} else if checked, ok := changed.(api.AfterStep); ok && checked.End {
			state.Refused = "step refused"
		}
		if _, err := w.record(context.WithoutCancel(ctx), state.Record()); err != nil {
			return nil, err
		}
		a.after, a.stepDecision, w.stepRefusal = true, state, state.Refused
		if state.Refused != "" {
			gate["refused"] = state.Refused
		}
		t.IO.Emit(ctx, api.Event{Kind: "step.end", Step: a.step, Data: api.JSON(after.Response.Usage)})
		return gate, nil
	case "tool.after":
		c := callIn(asObject(p["call"]))
		result := resultIn(asObject(p["result"]))
		cached, ok := w.results[c.ID]
		if !ok || c.Name != w.calls[c.ID].Name || !sameJSON(resultOut(result), resultOut(cached)) {
			return nil, fault("invalid_request", "tool.after requires a committed terminal result")
		}
		p["result"] = resultOut(cached)
		return p, nil
	case "turn.result":
		if !w.boundary() || w.resultChecked || w.active == nil || w.active.response.ID == "" {
			return nil, fault("invalid_request", "turn.result is outside a settlement boundary")
		}
		w.resultChecked = true
		r := asObject(p["result"])
		check := api.ResultCheck{Result: api.Text(str(r, "text"))}
		if v, ok := r["value"]; ok {
			check.Value = mustJSON(v)
		}
		v, err := invoke(check)
		if err != nil {
			return nil, err
		}
		check = v.(api.ResultCheck)
		if check.Continue != "" {
			w.resultRefused = true
			gate["refused"] = check.Continue
		} else {
			r["text"] = check.Result.Text()
			if len(check.Value) > 0 {
				r["value"] = check.Value
			} else {
				delete(r, "value")
			}
			p["result"] = r
		}
		return gate, nil
	}
	return nil, fault("invalid_request", "hook is not owned by the Runtime")
}
