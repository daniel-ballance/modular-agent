package harness

import (
	"github.com/OWNER/modular-agent/go/api"
	"maps"
	"slices"
)

// copySession detaches a snapshot for callers without running the entire
// history through JSON while holding the session lock.
func copySession(s api.Session) api.Session {
	s.Plugins = slices.Clone(s.Plugins)
	s.Ceiling = slices.Clone(s.Ceiling)
	if s.Limit != nil {
		s.Limit = new(slices.Clone(*s.Limit))
	}
	s.Actors = maps.Clone(s.Actors)
	for id, actor := range s.Actors {
		actor.Rights = slices.Clone(actor.Rights)
		s.Actors[id] = actor
	}
	s.Entries = slices.Clone(s.Entries)
	for i := range s.Entries {
		e := &s.Entries[i]
		e.Wire = slices.Clone(e.Wire)
		e.Data = slices.Clone(e.Data)
		e.Copies = slices.Clone(e.Copies)
		e.InputRefs = slices.Clone(e.InputRefs)
		if e.OfferedTools != nil {
			e.OfferedTools = new(slices.Clone(*e.OfferedTools))
		}
		if e.SafeToRepeat != nil {
			e.SafeToRepeat = new(*e.SafeToRepeat)
		}
		if e.OpenWorld != nil {
			e.OpenWorld = new(*e.OpenWorld)
		}
		e.Content = slices.Clone(e.Content)
		for j := range e.Content {
			part := &e.Content[j]
			part.Wire = slices.Clone(part.Wire)
			part.Data = slices.Clone(part.Data)
			if part.Call != nil {
				part.Call = new(*part.Call)
				part.Call.Input = slices.Clone(part.Call.Input)
				part.Call.Wire = slices.Clone(part.Call.Wire)
			}
		}
	}
	return s
}
