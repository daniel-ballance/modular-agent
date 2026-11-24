package contextview

import (
	"encoding/json"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type view struct {
	entries []api.Entry
	owners  map[[2]string]string
	results map[string]*api.Entry // terminal result, or the turn end that left the call open
}

func newView(branch, history []api.Entry) view {
	v := view{effective(branch), make(map[[2]string]string), make(map[string]*api.Entry)}
	for i, e := range branch {
		switch e.Kind {
		case "model.request":
			v.owners[[2]string{e.Turn, e.Step}] = api.Decode[api.Model](e.Data).Provider
		case "turn.end":
			for _, call := range api.Decode[api.Outcome](e.Data).Open {
				v.results[call.ID] = &branch[i]
			}
		}
	}
	// A settlement anywhere ends the wait. Only a visible result on this
	// branch supplies a message, even if it was committed in a later turn.
	for _, e := range history {
		if e.WasKind("tool.result") {
			delete(v.results, e.Call)
		}
	}
	for i, e := range v.entries {
		if e.Kind == "tool.result" {
			v.results[e.Call] = &v.entries[i]
		}
	}
	return v
}

func (v view) waitingForResult(part api.Part) bool {
	if part.Call == nil {
		return false
	}
	source := v.results[part.Call.ID]
	return source != nil && source.Kind == "turn.end"
}

func Messages(branch []api.Entry) ([]api.Message, []string) {
	v := newView(branch, branch)
	return v.messages(v.entries, "")
}

func forProvider(s api.Session, provider string) ([]api.Message, []string) {
	v := newView(s.Branch(), s.Entries)
	return v.messages(v.entries, provider)
}

func (v view) messages(entries []api.Entry, provider string) ([]api.Message, []string) {
	var out []api.Message
	var sources []string
	seen := make(map[string]bool)
	add := func(m api.Message, id string) {
		out = append(out, m)
		if !seen[id] {
			sources = append(sources, id)
			seen[id] = true
		}
	}
	for _, e := range entries {
		switch e.Kind {
		case "input", "summary":
			add(api.Message{Role: "user", Content: e.Content}, e.ID)
		case "model":
			meta := api.Decode[struct {
				Stop string
				Wire json.RawMessage
			}](e.Data)
			offered := meta.Stop == "tools" || meta.Stop == "finished"
			content := slices.DeleteFunc(slices.Clone(e.Content), func(p api.Part) bool {
				return p.Call != nil && (!offered || v.results[p.Call.ID] == nil)
			})
			if len(content) == 0 && (meta.Stop == "failed" || meta.Stop == "aborted") {
				continue
			}
			m := api.Message{Role: "assistant", Content: content, Wire: meta.Wire}
			if provider == "" || v.owners[[2]string{e.Turn, e.Step}] != provider {
				m = portable.PublicMessage(m)
			}
			add(m, e.ID)
			// Emit results with their response, in call-part order, never at
			// their commit positions. This also keeps compaction sources paired.
			for _, p := range content {
				if p.Call == nil {
					continue
				}
				source := v.results[p.Call.ID]
				var result api.ToolResult
				if source.Kind == "tool.result" {
					result = api.Decode[api.ToolResult](source.Data)
				} else {
					result = api.ToolResult{Call: p.Call.ID, Reference: p.Call.Reference, Name: p.Call.Name,
						Status: "open", Content: api.Text("This call is waiting for an answer. It has no result yet.")}
				}
				add(api.Message{Role: "tool", Result: &result}, source.ID)
			}
		}
	}
	return out, sources
}
