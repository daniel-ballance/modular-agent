package turnrun

import "github.com/daniel-ballance/modular-agent/go/api"

// ModelRequest marks the boundary after step preparation and before invoking
// the Provider. Preparation alone is not evidence of an external request.
func ModelRequest(step string, model api.Model) api.Entry {
	safe := !model.Stateful && !model.RunsTools || model.SafeToRepeatRequests
	return api.Entry{Kind: "model.request", Step: step, Data: api.JSON(model), SafeToRepeat: &safe}
}

// InFlightModelRequest finds the request for the interrupted step using only
// standard records. An erased response still settles its step.
func InFlightModelRequest(branch []api.Entry, turn string) (api.Entry, bool) {
	answered := map[string]bool{}
	for i := len(branch) - 1; i >= 0; i-- {
		e := branch[i]
		if e.Turn != turn {
			continue
		}
		switch {
		case e.WasKind("model"):
			answered[e.Step] = true
		case e.WasKind("model.request") && !answered[e.Step]:
			return e, true
		}
	}
	return api.Entry{}, false
}
