package api

import "errors"

var ErrErasureUnavailable = errors.New("pending erasure unavailable")
var ErrErasureUnsupported = errors.New("history has no pending erasure coordination")
var ErrErasureBusy = errors.New("erase refused while a turn, call or job runs")

// ErasureIntent contains identities only. The session record owns key
// reservations and the tombstones that prove deletion.
type ErasureIntent struct {
	ID      string        `json:"id"`
	Source  string        `json:"source"`
	Targets []string      `json:"targets"`
	Copies  []ErasureCopy `json:"copies"`
}
type ErasureCopy struct {
	EntryPair
	Complete bool `json:"complete,omitempty"`
}

// ErasureCoordinator serializes intent publication and participating readers,
// writers and fork publishers. A failed callback does not update the registry.
type ErasureCoordinator interface {
	PendingErasures(func(*[]ErasureIntent) error) error
}

// RemoteErasureCoordinator advertises a discovered service capability. Guard
// obtains a revision that the service checks atomically with the append.
type RemoteErasureCoordinator interface {
	ErasureCoordinated() bool
	GuardErasure(func([]ErasureIntent, string) error) error
}

func PendingRegistry(store any) ErasureCoordinator {
	if r, ok := store.(RemoteErasureCoordinator); ok && !r.ErasureCoordinated() {
		return nil
	}
	r, _ := store.(ErasureCoordinator)
	return r
}

type GuardedErasureLease interface {
	SaveGuarded(Session, string) error
}

// ExactErasureLease installs tombstones without touching another session.
type ExactErasureLease interface {
	SaveErasure(Session) error
}
