// Package apikeymodels reads the shared catalog for API-key Providers.
package apikeymodels

import (
	_ "embed"
	"encoding/json"
	"maps"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
)

//go:embed api-key-models.json
var source []byte

var order = []string{"off", "minimal", "low", "medium", "high", "xhigh"}

type Model struct {
	Provider, ID             string
	ContextWindow, MaxOutput int
	Input                    []string
	Reasoning                bool
	Levels                   map[string]map[string]json.RawMessage
}

var catalog = func() []Model {
	var table struct{ Models []Model }
	if err := json.Unmarshal(source, &table); err != nil {
		panic(err)
	}
	return table.Models
}()

func Lookup(provider, id string) (Model, bool) {
	for _, m := range catalog {
		if m.Provider == provider && m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}

func Catalog(provider string) []Model {
	var out []Model
	for _, m := range catalog {
		if m.Provider == provider {
			out = append(out, m)
		}
	}
	return out
}

func (m Model) Thinking() []string {
	var out []string
	for _, l := range order {
		if m.Levels[l] != nil {
			out = append(out, l)
		}
	}
	return out
}

// Apply sends only the fields in the selected entry. An unset level keeps the vendor default.
func Apply(payload map[string]any, provider, id, level string, maxOutput int) {
	m, ok := Lookup(provider, id)
	if !ok || level == "" || !slices.Contains(order, level) {
		return
	}
	fields := m.Levels[api.LowerReasoning(level, m.Thinking())]
	if raw := fields["thinking"]; raw != nil {
		var thinking struct {
			Type   string `json:"type"`
			Budget int    `json:"budget_tokens"`
		}
		if err := json.Unmarshal(raw, &thinking); err != nil {
			panic(err)
		}
		if thinking.Type == "enabled" {
			thinking.Budget = min(thinking.Budget, maxOutput-1)
			if thinking.Budget < 1024 {
				fields = m.Levels["off"]
			} else {
				fields = maps.Clone(fields)
				fields["thinking"] = api.JSON(thinking)
			}
		}
	}
	for k, v := range fields {
		payload[k] = v
	}
}
