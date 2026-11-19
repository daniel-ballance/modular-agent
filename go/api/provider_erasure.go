package api

import "context"

type EntryPair struct {
	SessionID string `json:"sessionId"`
	ID        string `json:"id"`
}

type ErasedInputKey struct {
	InputID     string `json:"inputId"`
	Key         string `json:"key"`
	ActorID     string `json:"actorId,omitempty"`
	SubmittedBy string `json:"submittedBy,omitempty"`
}

type ErasureRecord struct {
	EntryIDs  []string         `json:"entryIds"`
	InputKeys []ErasedInputKey `json:"inputKeys,omitempty"`
}

func ReadErasureRecord(data []byte) ErasureRecord {
	record := Decode[ErasureRecord](data)
	if record.EntryIDs == nil {
		record.EntryIDs = Decode[[]string](data)
	}
	return record
}

// ProviderErasure describes remote copies a Provider could not delete.
type ProviderErasure struct {
	ErasedPairs  []EntryPair `json:"-"`
	PendingPairs []EntryPair `json:"-"`
	Pending      []string    `json:"pending,omitempty"`
	// OutOfReach describes out-of-reach copies for people; these are not codes.
	OutOfReach []string `json:"outOfReach,omitempty"`
}

// ProviderEraser is implemented by Providers that delete remote copies when
// the Harness erases history. This also discards their state for the session.
type ProviderEraser interface {
	EraseState(ctx context.Context, sessionID string, entryIDs []string) (ProviderErasure, error)
}
