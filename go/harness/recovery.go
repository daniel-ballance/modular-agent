package harness

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
)

// Replay uses the branch only to select interrupted turns. Intake and terminal
// facts belong to the whole session, including records written after a move.
func recovery(s api.Session) (*api.Entry, []api.Input) {
	interrupted := s.UnfinishedTurn()
	var orphan *api.Input
	initial := map[string]api.Input{}
	for _, e := range s.LiveEntries() {
		if e.Kind == "input.accepted" {
			in := api.Decode[api.Input](e.Data)
			initial[in.ID] = in
		}
	}
	// A fork's display prefix is context, not an interrupted turn to resume.
	live := s
	live.Entries = s.LiveEntries()
	for _, e := range live.Branch() {
		switch {
		case e.WasKind("turn.end") || e.Kind == "turn.start":
			orphan = nil
		case e.Kind == "input" && e.Turn == "" && interrupted == nil:
			// Old Go records could take input before writing the turn start.
			if in, ok := initial[e.InputID()]; ok {
				orphan = &in
			}
		}
	}
	var queue []api.Input
	if orphan != nil {
		for _, e := range s.LiveEntries() {
			if slices.Contains(e.HandedBackIDs(), orphan.ID) {
				orphan = nil
				break
			}
		}
		if orphan != nil {
			queue = append(queue, *orphan)
		}
	}
	for _, e := range pendingAdmissions(s) {
		queue = append(queue, api.Decode[api.Input](e.Data))
	}
	return interrupted, queue
}

func pendingAdmissions(s api.Session) []api.Entry {
	entries := s.LiveEntries()
	settled := map[string]bool{}
	var pending []api.Entry
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		switch {
		case e.WasKind("input"):
			settled[e.InputID()] = true
		case e.WasKind("input.accepted"):
			id := e.InputRef
			if !e.IsErased() {
				id = api.Decode[api.Input](e.Data).ID
				if id != "" && !settled[id] {
					pending = append(pending, e)
				}
			}
			settled[id] = true
		default:
			for _, id := range e.HandedBackIDs() {
				settled[id] = true
			}
		}
	}
	slices.Reverse(pending)
	return pending
}

func parked(in api.Input) bool {
	return in.When == "propose" || in.Job != "" && in.ReleasedBy == "" && (in.Parked == nil || *in.Parked)
}

func runnableInput(queue []api.Input) int {
	return slices.IndexFunc(queue, func(in api.Input) bool { return !parked(in) })
}

func samePlugins(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
