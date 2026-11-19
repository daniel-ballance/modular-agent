package history

import (
	"errors"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

func sameStoredEntry(old, next api.Session, a, b api.Entry) bool {
	if len(old.HistoryMeta) != 0 && len(next.HistoryMeta) != 0 {
		return portable.EqualJSON(portable.HistoryEntry(old, a), portable.HistoryEntry(next, b))
	}
	return portable.Same(a, b)
}

// SaveErasure installs the history service's exact tombstones without applying
// the Harness's separate copy-closure policy. It uses the existing writer lock.
func (l *lease) SaveErasure(snap api.Session) error {
	s := l.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.closed {
		return errors.New("lease closed")
	}
	unlock, err := s.guard()
	if err != nil {
		return err
	}
	defer unlock()
	old, err := s.load(l.id)
	if err != nil {
		return err
	}
	if snap.ID != l.id || len(snap.Entries) != len(old.Entries) {
		return errors.New("invalid erasure snapshot")
	}
	for i, e := range old.Entries {
		next := snap.Entries[i]
		if next.ID != e.ID || (!next.IsErased() && !sameStoredEntry(old, snap, e, next)) || (e.IsErased() && !next.IsErased()) {
			return errors.New("erasure changed an unrelated entry")
		}
	}
	l.saved = nil
	return s.save(snap)
}
