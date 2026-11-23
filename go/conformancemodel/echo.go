// Package conformancemodel is the credential-free model in docs/bindings/acp.md.
// It is installed only by the explicit MODULAR_AGENT_CONFORMANCE=1 launch mode.
package conformancemodel

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
	"strings"
)

const ID = "conformance/echo"

type provider struct{}

func New() api.Provider { return provider{} }

func Plugin() api.Plugin {
	return api.Plugin{Name: "conformance", Setup: func(a api.API) error { return a.Provide("provider.conformance", provider{}) }}
}
func (provider) Catalog() []api.Model {
	// Echo ignores reasoning. Accept every binding level so a session from
	// another build can keep its recorded setting when it resumes.
	return []api.Model{{ID: ID, Provider: "conformance", Context: 1000000, Output: 4096, Thinking: []string{"off", "minimal", "low", "medium", "high", "xhigh"}}}
}
func (p provider) Access(id string) (api.ModelAccess, error) {
	if id != ID {
		return nil, errors.New("unknown conformance model")
	}
	return p, nil
}
func (p provider) Model() api.Model { return p.Catalog()[0] }
func (provider) Generate(ctx context.Context, r api.Request, emit func(api.Part)) (api.Response, error) {
	if err := ctx.Err(); err != nil {
		return api.Response{}, err
	}
	latest := -1
	text := ""
	for i, m := range r.Messages {
		if m.Role == "user" && m.Result == nil {
			latest = i
			text = m.Content.Text()
		}
	}
	// The fixture meters zero tokens rather than leaving usage unreported.
	if message, failed := strings.CutPrefix(text, "fail:"); failed {
		return api.Response{Stop: "failed", UsageReported: true}, &api.ModelError{Kind: "other", Message: message}
	}
	reply := "echo: " + text
	if directive, yes := strings.CutPrefix(text, "tool:"); yes {
		name, raw, found := strings.Cut(directive, " ")
		var input map[string]json.RawMessage
		if !found || name == "" || json.Unmarshal([]byte(raw), &input) != nil || input == nil ||
			!slices.ContainsFunc(r.Tools, func(tool api.Tool) bool { return tool.Name == name }) {
			return api.Response{Stop: "failed", UsageReported: true}, &api.ModelError{Kind: "other", Message: "Invalid tool directive"}
		}
		for _, m := range r.Messages[latest+1:] {
			if m.Result != nil {
				result := []rune(m.Result.Content.Text())
				if len(result) > 200 {
					result = result[:200]
				}
				reply = "done: " + string(result)
				emit(api.Part{Type: "text", Text: reply})
				return api.Response{Content: api.Text(reply), Stop: "finished", UsageReported: true}, nil
			}
		}
		return api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: api.ID(), Name: name, Input: json.RawMessage(raw)}}}, Stop: "tools", UsageReported: true}, nil
	}
	emit(api.Part{Type: "text", Text: reply})
	return api.Response{Content: api.Text(reply), Stop: "finished", UsageReported: true}, nil
}
