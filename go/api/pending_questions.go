package api

import (
	"encoding/json"
	"slices"
)

// PendingQuestionCheckpoint identifies the questions and start belonging to
// this invocation. A continued invocation starts a new set of waits.
func PendingQuestionCheckpoint(s Session, turn, call string) json.RawMessage {
	ids := []string{}
	var start string
	for _, e := range s.Branch() {
		if e.Turn != turn || e.Call != call {
			continue
		}
		switch e.Kind {
		case "tool.started":
			start, ids = e.ID, []string{}
		case "question.open":
			q := Decode[struct{ Question Question }](e.Data).Question
			if q.ID != "" && q.Defer {
				ids = append(ids, q.ID)
			}
		}
	}
	return JSON(struct {
		RequestIDs    []string `json:"requestIds"`
		ToolStartedID string   `json:"toolStartedId,omitempty"`
	}{ids, start})
}

// HasQuestionCheckpoint binds a deferred question to the actual host commit.
// A question, answer or turn end alone cannot authorize a continuation.
func HasQuestionCheckpoint(s Session, q Question) bool {
	if q.Session != s.ID || q.ID == "" || q.Call == "" {
		return false
	}
	s.Entries = s.LiveEntries()
	opened := false
	for _, e := range s.Branch() {
		if e.Session != s.ID || e.Call != q.Call || e.Turn != q.Turn || e.Step != q.Step {
			continue
		}
		switch e.Kind {
		case "question.open":
			if Decode[struct{ Question Question }](e.Data).Question.ID == q.ID {
				opened = true
			}
		case "tool.open":
			if opened && slices.Contains(Decode[struct{ RequestIDs []string }](e.Data).RequestIDs, q.ID) {
				return true
			}
		}
	}
	return false
}
