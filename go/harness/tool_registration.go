package harness

import "github.com/daniel-ballance/modular-agent/go/api"

func (p *turnPorts) toolRegistration(name string) *api.ToolRegistration {
	plugin, source, _, ok := p.ToolRegistration(name)
	if !ok {
		return nil
	}
	return &api.ToolRegistration{Plugin: plugin, ToolSource: source}
}
