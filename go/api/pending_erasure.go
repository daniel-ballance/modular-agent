package api

import "errors"

var ErrErasureUnavailable = errors.New("pending erasure unavailable")
var ErrErasureUnsupported = errors.New("history has no pending erasure coordination")
var ErrErasureBusy = errors.New("erase refused while a turn, call or job runs")

// ErasureIntent contains identities only. The session record owns key
// reservations and the tombstones that prove deletion.
type ErasureIntent struct {
	ID        string            `json:"id"`
	Source    string            `json:"source"`
	Targets   []string          `json:"targets"`
	Copies    []ErasureCopy     `json:"copies"`
	Providers []ErasureProvider `json:"providers,omitempty"`
}
type ErasureCopy struct {
	EntryPair
	Complete bool `json:"complete,omitempty"`
}

type ErasureProvider struct {
	SessionID string `json:"sessionId"`
	Provider  string `json:"provider"`
	Complete  bool   `json:"complete,omitempty"`
}

// ErasureCoordinator serializes intent publication and participating readers,
// writers and fork publishers. A failed callback does not update the registry.
type ErasureCoordinator interface {
	PendingErasures(func(*[]ErasureIntent) error) error
}

// RemoteErasureCoordinator reads the history service's per-session plans.
// The revision from a complete read can fence a subsequent discovery scan.
type RemoteErasureCoordinator interface {
	ErasureCoordinated() bool
	ErasurePlans(sessionID string) ([]ErasurePlan, string, error)
}

type ErasurePlan struct {
	IntentID string
	SourceID string
	RecordID string
	Copies   []ErasureCopy
}

type RemoteErasureLease interface {
	LoadErasure() (Session, error)
	PublishErasure(revision string, intent ErasureIntent) (string, error)
	CompleteErasure(intentID string, ids []string) error
}

func PendingRegistry(store any) ErasureCoordinator {
	r, _ := store.(ErasureCoordinator)
	return r
}

func RemoteRegistry(store any) RemoteErasureCoordinator {
	r, _ := store.(RemoteErasureCoordinator)
	if r != nil && r.ErasureCoordinated() {
		return r
	}
	return nil
}

// ExactErasureLease installs tombstones without touching another session.
type ExactErasureLease interface {
	SaveErasure(Session) error
}
