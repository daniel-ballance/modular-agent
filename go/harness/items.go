package harness

import (
	"context"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"maps"
	"strings"
)

// LoadExternal selects individual local items for a stdio adapter. Setup and
// collision checks are tentative: on refusal the caller still owns the process
// and can send it the refusal before shutting it down.
func (h *Harness) LoadExternal(p api.Plugin, replaces []string) error {
	if p.Name == "" || p.Name == "harness" || p.Setup == nil || p.Replaces != "" {
		return errors.New("invalid external plugin")
	}
	if _, err := h.API().Invoke(context.Background(), "plugin.load", p.Name); err != nil {
		return err
	}
	h.mu.Lock()
	if len(h.sessions) > 0 {
		h.mu.Unlock()
		return errors.New("plugins are fixed while sessions are open")
	}
	if _, ok := h.plugins[p.Name]; ok {
		h.mu.Unlock()
		return errors.New("duplicate plugin")
	}
	seen := map[string]bool{}
	for _, item := range replaces {
		if seen[item] {
			h.mu.Unlock()
			return fmt.Errorf("duplicate replacement item %q", item)
		}
		seen[item] = true
		if h.external[item] {
			h.mu.Unlock()
			return fmt.Errorf("cannot replace another external item %s", item)
		}
		if item != "runtime" && item != "working-environment" && !strings.HasPrefix(item, "provider:") && !strings.HasPrefix(item, "command:") && !strings.HasPrefix(item, "tool:") {
			h.mu.Unlock()
			return fmt.Errorf("unknown replacement item %q", item)
		}
	}
	caps, commands, hooks := h.caps, h.commands, h.hooks
	h.caps, h.commands, h.hooks = maps.Clone(caps), maps.Clone(commands), make(map[string]*hook, len(hooks))
	for name, point := range hooks {
		copy := *point
		copy.handlers = append([]handler(nil), point.handlers...)
		h.hooks[name] = &copy
	}
	var oldEnv api.WorkingEnvironment
	for _, item := range replaces {
		switch {
		case item == "runtime":
			if r, ok := h.caps[item]; ok {
				delete(h.caps, item)
				for name := range api.RuntimeHooks() {
					if point := h.hooks[name]; point != nil && point.owner == r.owner {
						point.owner, point.rebinding = p.Name, true
					}
				}
			}
		case item == "working-environment":
			if r, ok := h.caps[item]; ok {
				oldEnv = r.value.(api.WorkingEnvironment)
				delete(h.caps, item)
			}
		case strings.HasPrefix(item, "provider:"):
			delete(h.caps, "provider."+strings.TrimPrefix(item, "provider:"))
		case strings.HasPrefix(item, "command:"):
			delete(h.commands, strings.TrimPrefix(item, "command:"))
		case strings.HasPrefix(item, "tool:"):
			name := strings.TrimPrefix(item, "tool:")
			for key, r := range h.caps {
				if strings.HasPrefix(key, "tools.") && !h.externalPlugins[r.owner] {
					r.value = &excludedSource{ToolSource: r.value.(api.ToolSource), name: name}
					h.caps[key] = r
				}
			}
		}
	}
	h.plugins[p.Name] = p
	h.order = append(h.order, p.Name)
	h.mu.Unlock()

	var externalTools []string
	err := p.Setup(&client{h: h, owner: p.Name})
	if err == nil {
		// Static lists are checked now. Per-session lists are checked again when
		// composing a turn, using the existing duplicate-name check.
		names := map[string]bool{}
		for _, source := range h.API().All("tools.") {
			for _, t := range source.(api.ToolSource).Tools(api.Session{}) {
				if names[t.Name] {
					err = fmt.Errorf("duplicate tool %s", t.Name)
				}
				names[t.Name] = true
			}
		}
		if err == nil {
			h.mu.RLock()
			var sources []api.ToolSource
			for key, r := range h.caps {
				if r.owner == p.Name && strings.HasPrefix(key, "tools.") {
					sources = append(sources, r.value.(api.ToolSource))
				}
			}
			h.mu.RUnlock()
			for _, source := range sources {
				for _, t := range source.Tools(api.Session{}) {
					externalTools = append(externalTools, "tool:"+t.Name)
				}
			}
		}
	}
	h.mu.Lock()
	if err != nil {
		delete(h.plugins, p.Name)
		h.order = h.order[:len(h.order)-1]
		h.caps, h.commands, h.hooks = caps, commands, hooks
		h.mu.Unlock()
		return err
	}
	for key, r := range h.caps {
		if r.owner != p.Name {
			continue
		}
		switch {
		case key == "working-environment" || key == "runtime":
			h.external[key] = true
		case strings.HasPrefix(key, "provider."):
			h.external["provider:"+strings.TrimPrefix(key, "provider.")] = true
		}
	}
	for name, r := range h.commands {
		if r.owner == p.Name {
			h.external["command:"+name] = true
		}
	}
	for _, item := range externalTools {
		h.external[item] = true
	}
	h.externalPlugins[p.Name] = true
	h.mu.Unlock()
	if oldEnv != nil {
		if err := oldEnv.Close(); err != nil {
			h.API().Emit(context.Background(), api.Event{Kind: "plugin.problem", Data: api.JSON(map[string]string{"where": "working-environment", "message": err.Error()})})
		}
	}
	return nil
}

type excludedSource struct {
	api.ToolSource
	name string
}

func (s *excludedSource) Run(ctx context.Context, session api.Session, call api.Call, progress func(string)) api.ToolResult {
	if call.Name == s.name {
		return api.ToolResult{Call: call.ID, Status: "failed", Content: api.Text("tool removed by external replacement")}
	}
	return s.ToolSource.Run(ctx, session, call, progress)
}
func (s *excludedSource) Tools(session api.Session) []api.Tool {
	out := []api.Tool{}
	for _, t := range s.ToolSource.Tools(session) {
		if t.Name != s.name {
			out = append(out, t)
		}
	}
	return out
}
