package contextview

import "github.com/daniel-ballance/modular-agent/go/api"

// A late Interface result belongs to the original assistant message even if
// another turn took input before the result arrived. Move only the model view;
// the history, source IDs, and commit order remain untouched.
func orderInterfaceResults(entries, branch []api.Entry) []api.Entry {
	checkpoints := map[string]api.Entry{}
	for _, e := range branch {
		if e.Kind == api.InterfaceHandoffKind {
			checkpoints[e.Call] = e
		}
	}
	if len(checkpoints) == 0 {
		return entries
	}
	results := map[string]api.Entry{}
	for _, e := range entries {
		if e.Kind == "tool.result" && checkpoints[e.Call].Turn == e.Turn && checkpoints[e.Call].Step == e.Step && checkpoints[e.Call].ID != "" {
			results[e.Call] = e
		}
	}
	if len(results) == 0 {
		return entries
	}
	paired := map[string]bool{}
	for _, e := range entries {
		if e.Kind == "model" {
			for _, p := range e.Content {
				if p.Call != nil && results[p.Call.ID].ID != "" {
					paired[p.Call.ID] = true
				}
			}
		}
	}
	ordered := make([]api.Entry, 0, len(entries))
	for _, e := range entries {
		if e.Kind == "tool.result" && paired[e.Call] && e.ID == results[e.Call].ID {
			continue
		}
		ordered = append(ordered, e)
		if e.Kind != "model" {
			continue
		}
		for _, p := range e.Content {
			if p.Call != nil && paired[p.Call.ID] {
				ordered = append(ordered, results[p.Call.ID])
			}
		}
	}
	return ordered
}
