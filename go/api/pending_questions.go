package api

import "encoding/json"

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
