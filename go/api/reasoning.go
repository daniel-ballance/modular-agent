package api

import "slices"

// LowerReasoning picks the nearest accepted level at or below the request.
// With no such level, omit the request rather than raising it.
func LowerReasoning(level string, accepted []string) string {
	if level == "" || slices.Contains(accepted, level) {
		return level
	}
	order := []string{"off", "minimal", "low", "medium", "high", "xhigh"}
	rank := slices.Index(order, level)
	if rank < 0 {
		rank = 0
	}
	for i := rank; i >= 0; i-- {
		if slices.Contains(accepted, order[i]) {
			return order[i]
		}
	}
	return ""
}
