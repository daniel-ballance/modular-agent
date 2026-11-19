package api

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
