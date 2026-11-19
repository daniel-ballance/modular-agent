package api

import (
	"bytes"
	"encoding/json"
	"errors"
)

type RestoreIntent struct {
	Point string `json:"point"`
	Undo  string `json:"undo"`
}

type PositionChange struct {
	To      *string        `json:"to"`
	Restore *RestoreIntent `json:"restore,omitempty"`
	Failed  bool           `json:"failed,omitempty"` // legacy, never a completion
}

func (p PositionChange) Target() string {
	if p.To == nil {
		return ""
	}
	return *p.To
}

func ReadPosition(data json.RawMessage) (PositionChange, error) {
	var p PositionChange
	data = bytes.TrimSpace(data)
	if len(data) > 0 && data[0] == '"' { // native snapshots from before the journal
		err := json.Unmarshal(data, &p.To)
		return p, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields["to"] == nil {
		return p, errors.New("position has no valid target")
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return p, err
	}
	if (p.To != nil && *p.To == "") || (fields["restore"] != nil &&
		(p.Restore == nil || p.Restore.Point == "" || p.Restore.Undo == "" || p.Restore.Point == p.Restore.Undo)) {
		return p, errors.New("invalid position target or restore intent")
	}
	return p, nil
}
