package modelcatalog

import (
	"slices"

	"github.com/daniel-ballance/modular-agent/go/internal/apikeymodels"
	"github.com/daniel-ballance/modular-agent/go/modular"
)

func Models(provider, selected string, enrolled []modular.ModelInfo) []modular.ModelInfo {
	var out []modular.ModelInfo
	seen := make(map[string]bool)
	for _, m := range apikeymodels.Catalog(provider) {
		seen[m.ID] = true
		if selected == "" || selected == m.ID {
			out = append(out, modular.ModelInfo{ModelRef: modular.ModelRef{Provider: provider, ID: m.ID},
				ContextWindow: m.ContextWindow, MaxOutput: m.MaxOutput, Input: slices.Clone(m.Input),
				Reasoning: m.Reasoning, Thinking: m.Thinking()})
		}
	}
	for _, m := range enrolled {
		if !seen[m.ID] && m.ID != "" && (selected == "" || selected == m.ID) {
			m.Provider, m.Thinking, m.Input = provider, nil, slices.Clone(m.Input)
			out = append(out, m)
			seen[m.ID] = true
		}
	}
	if selected != "" && len(out) == 0 {
		out = append(out, modular.ModelInfo{ModelRef: modular.ModelRef{Provider: provider, ID: selected}, Input: []string{"text"}})
	}
	return out
}
