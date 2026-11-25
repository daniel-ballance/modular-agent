package harness

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"strings"
)

// ToolRegistration resolves the currently registered source and definition.
// The source may refresh, so do not hold either Harness lock while reading it.
func (p *turnPorts) ToolRegistration(name string) (string, string, api.Tool, bool) {
	plugin, source, definition, _, _, found := p.resolveTool(name)
	return plugin, source, definition, found
}

func (p *turnPorts) resolveTool(name string) (plugin, source string, definition api.Tool, executor api.ToolSource, snap api.Session, found bool) {
	snap, err := p.Snapshot()
	if err != nil {
		return
	}
	p.c.h.mu.RLock()
	sources := map[string]registration{}
	for id, r := range p.c.h.caps {
		if strings.HasPrefix(id, "tools.") {
			sources[id] = r
		}
	}
	p.c.h.mu.RUnlock()
	for id, r := range sources {
		s := r.value.(api.ToolSource)
		for _, tool := range s.Tools(snap) {
			if tool.Name != name {
				continue
			}
			if found {
				return "", "", api.Tool{}, nil, snap, false
			}
			plugin, source = r.owner, strings.TrimPrefix(id, "tools.")
			if identity, ok := s.(interface{ ToolSourceIdentity() (string, string) }); ok {
				plugin, source = identity.ToolSourceIdentity()
			}
			definition, executor, found = tool, s, true
		}
	}
	return
}

func (p *turnPorts) toolRegistration(name string) *api.ToolRegistration {
	plugin, source, _, ok := p.ToolRegistration(name)
	if !ok {
		return nil
	}
	return &api.ToolRegistration{Plugin: plugin, ToolSource: source}
}
