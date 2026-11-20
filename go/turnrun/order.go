package turnrun

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
)

// ModelCallOrder restores the assistant's call order without changing the
// order in history, where every result is recorded as soon as it is ready.
func ModelCallOrder(messages []api.Message) []api.Message {
	out := slices.Clone(messages)
	for i, m := range messages {
		if m.Role != "assistant" {
			continue
		}
		order := map[string]int{}
		for n, p := range m.Content {
			if p.Call != nil {
				order[p.Call.ID] = n
			}
		}
		end := i + 1
		for ; end < len(out) && out[end].Result != nil; end++ {
			if _, ok := order[out[end].Result.Call]; !ok {
				break
			}
		}
		slices.SortStableFunc(out[i+1:end], func(a, b api.Message) int {
			return order[a.Result.Call] - order[b.Result.Call]
		})
	}
	return out
}
