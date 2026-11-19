package api

import "slices"

// OffersModelTool narrows the current model offer, not tool authority.
func OffersModelTool(s Settings, t Tool) bool {
	return CanCall(t, "model") && (s.ModelTools == nil || slices.Contains(*s.ModelTools, t.Name))
}

// CanCall defaults an omitted callers field to all callers. Provider-originated
// calls are model work; calls started by another tool are plugin work.
func CanCall(t Tool, origin string) bool {
	if t.Callers == nil {
		return true
	}
	switch origin {
	case "provider":
		origin = "model"
	case "tool":
		origin = "plugin"
	}
	for _, caller := range t.Callers {
		if caller == origin {
			return true
		}
	}
	return false
}
