package harness

import (
	"errors"
	"modular/api"
	"strings"
)

// WrapProviders installs binding middleware on the local Providers, before any
// session opens. No capability is added, hidden or looked up by precedence.
func (h *Harness) WrapProviders(wrap func(string, api.Provider) api.Provider) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.sessions) > 0 {
		return errors.New("plugins are fixed while sessions are open")
	}
	for key, r := range h.caps {
		if strings.HasPrefix(key, "provider.") {
			r.value = wrap(strings.TrimPrefix(key, "provider."), r.value.(api.Provider))
			h.caps[key] = r
		}
	}
	return nil
}
