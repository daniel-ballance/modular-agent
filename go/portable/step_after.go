package portable

import (
	"bytes"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
)

const StepAfterKind = "modular-agent.stepAfter"

// StepAfter is a checkpoint, not a hook result inferred from a response or turn end.
// Committed distinguishes a recorded allowance from a gate still due.
type StepAfter struct {
	Request, Response api.Entry
	Committed         bool
	Refused           string
}

func (s StepAfter) Decision() any {
	if s.Refused != "" {
		return map[string]any{"refuse": s.Refused}
	}
	return nil
}

func (s StepAfter) Record() api.Entry {
	return api.Entry{Kind: StepAfterKind, Step: s.Response.Step, Data: api.JSON(object{"decision": s.Decision()})}
}

// LastAnsweredStep finds the last real response in the interrupted turn. An
// erased or off-branch decision is evidence that the gate is not safe to rerun.
func LastAnsweredStep(session api.Session, turn string) (StepAfter, error) {
	var state StepAfter
	requests := map[string]api.Entry{}
	branch := session.Branch()
	if len(branch) == 0 || branch[0].Parent != "" {
		return state, fmt.Errorf("incomplete step checkpoint")
	}
	for _, e := range branch {
		if e.Turn != turn {
			continue
		}
		switch {
		case e.WasKind("model.request"):
			requests[e.Step] = e
		case e.WasKind("model"):
			r := requests[e.Step]
			d := asObject(obj(r.Wire)["data"])
			answer := asObject(obj(e.Wire)["data"])
			if boolean(d, "auxiliary") || str(d, "purpose") == "summary" || boolean(answer, "auxiliary") || boolean(answer, "recovery") {
				continue
			}
			state.Request, state.Response = r, e
		}
	}
	if state.Response.ID == "" {
		return state, nil
	}
	step := state.Response.Step
	if step == "" || state.Response.IsErased() || state.Request.ID == "" || state.Request.IsErased() {
		return StepAfter{}, fmt.Errorf("step %q has no intact answered checkpoint", step)
	}
	inBranch := map[string]bool{}
	for _, e := range branch {
		inBranch[e.ID] = true
	}
	for _, e := range session.Entries {
		if !e.WasKind(StepAfterKind) || e.Step != step {
			continue
		}
		decision, present := obj(e.Data)["decision"]
		if state.Committed || e.Turn != turn || !inBranch[e.ID] || e.IsErased() || !present {
			return StepAfter{}, fmt.Errorf("step %q has uncertain gate state", step)
		}
		if !bytes.Equal(api.JSON(decision), []byte("null")) {
			refusal := asObject(decision)
			state.Refused = str(refusal, "refuse")
			if len(refusal) != 1 || state.Refused == "" {
				return StepAfter{}, fmt.Errorf("step %q has invalid gate decision", step)
			}
		}
		state.Committed = true
	}
	if !state.Committed && !state.Request.TracksStepAfter {
		return StepAfter{}, fmt.Errorf("step %q does not track the gate decision", step)
	}
	return state, nil
}
