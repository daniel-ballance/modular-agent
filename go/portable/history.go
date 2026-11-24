package portable

import (
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"
)

func ReadErased(raw json.RawMessage) bool {
	var v struct{ Erased bool }
	return json.Unmarshal(raw, &v) == nil && v.Erased
}

// StoreEntry keeps opaque HTTP rows even if they are not valid portable work.
func StoreEntry(raw json.RawMessage) api.Entry {
	e, err := ReadEntry(raw)
	if err != nil {
		return api.Entry{ID: e.ID, Parent: e.Parent, Kind: api.InvalidHistoryKind, Wire: raw}
	}
	e.Wire = raw
	return e
}

// HistoryEntry encodes a stored entry. For HTTP-originated sessions, retain
// the exact binding object, including old or unknown fields, on disk.
func HistoryEntry(s api.Session, e api.Entry) json.RawMessage {
	if len(s.HistoryMeta) != 0 && len(e.Wire) != 0 {
		var v struct {
			ID     string
			Erased bool
		}
		if json.Unmarshal(e.Wire, &v) == nil && v.ID == e.ID && v.Erased == e.IsErased() {
			return e.Wire
		}
	}
	return api.JSON(Entry(e))
}
