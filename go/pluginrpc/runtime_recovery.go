package pluginrpc

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

// restoreInterrupted finishes host-owned bookkeeping before giving the Runtime
// a parent that can start effects. A pending checkpoint is not permission to
// run a call, even if the original questions have since been answered.
func (w *runtimeWork) restoreInterrupted(ctx context.Context, snap api.Session, durable bool) (object, error) {
	t := w.turn
	calls := []object{}
	for _, interrupted := range interruptedCalls(snap, t) {
		c := interrupted.call
		w.calls[c.ID], w.committed[c.ID] = c, true
		w.offered[c.ID] = recordedOffer(snap, c)
		if interrupted.pending {
			w.pending[c.ID] = true
			continue
		}
		def, known := w.definition(c.Name)
		eligible := durable && known && api.CanCall(def, c.Origin) && w.offered[c.ID]
		if interrupted.started {
			eligible = eligible && interrupted.repeat && def.SafeRepeat && t.CanRepeat && w.canRepeatRegistration(c.Name, interrupted.start)
			if eligible {
				w.repeating[c.ID] = true
				w.priorInputs[c.ID] = api.Decode[api.Call](interrupted.start.Data).Input
			}
		}
		if !eligible {
			result := api.ToolResult{Status: "not_started", Content: api.Text("Interrupted call was not eligible to start.")}
			if interrupted.started {
				result = unknownInterruptedCall(c)
			}
			if _, err := w.settleTool(ctx, c, result); err != nil {
				return nil, err
			}
			continue
		}
		calls = append(calls, pendingCallOut(c, interrupted.started, interrupted.started))
	}
	if err := w.recoverAttempts(ctx, snap, durable); err != nil {
		return nil, err
	}
	if !durable {
		return nil, fault("invalid_request", "turn interrupted by process stop")
	}
	state, err := portable.LastAnsweredStep(snap, t.ID)
	if err != nil {
		return nil, err
	}
	next := object{"turnId": t.ID, "calls": calls}
	if state.Response.ID != "" {
		step := state.Response.Step
		a := &runtimeAttempt{step: step, intent: state.Request, response: state.Response,
			answer: asObject(portable.Entry(state.Response)["message"]), after: state.Committed, stepDecision: state}
		w.active, w.responses[step], w.stepRefusal = a, a, state.Refused
		if str(a.answer, "stop") == "length" {
			w.limit = "output"
		}
		last := object{"stepId": step}
		if state.Committed {
			last["decision"] = state.Decision()
		}
		next["lastStep"] = last
	}
	return next, nil
}
