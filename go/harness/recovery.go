package harness

import (
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
)

// Replay uses the branch only to select interrupted turns. Intake and terminal
// facts belong to the whole session, including records written after a move.
func recovery(s api.Session) (*api.Entry, []api.Input) {
	var queue []api.Input
	for _, e := range pendingAdmissions(s) {
		queue = append(queue, api.Decode[api.Input](e.Data))
	}
	return s.UnfinishedTurn(), queue
}

// Check intake order before running any reopen hook or starting a worker.
func validateIntake(s api.Session) error {
	started := map[string]bool{}
	for _, e := range s.LiveEntries() {
		if e.Kind == api.InvalidHistoryKind {
			return fmt.Errorf("unusable history entry %s", e.ID)
		}
		if e.WasKind("turn.start") && e.Turn != "" {
			started[e.Turn] = true
		}
		if e.Kind == "input" && !started[e.Turn] {
			return fmt.Errorf("taken input %s has no preceding turn start", e.ID)
		}
	}
	return validateJobReports(s)
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
		case e.WasKind("input.returned"):
			settled[e.InputRef] = true
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
