package api

func (e Entry) AuthorityRecord() bool {
	switch e.Kind {
	case "tenant", "limit", "actor.set", "actor.left", "job.cleanup":
		return true
	}
	return false
}

func (e Entry) IsErased() bool { return e.Kind == "erased" || e.Kind == "erasure" && len(e.Data) == 0 }

// WasKind includes erased records when checking what happened, not their content.
func (e Entry) WasKind(kind string) bool {
	return e.Kind == kind || e.IsErased() && e.OriginalKind == kind
}

// Redacted holds only the identities that survive erasure. Never keep Wire:
// it may contain opaque fields, including copies of the payload being erased.
func (e Entry) Redacted() Entry {
	kind := e.Kind
	if e.IsErased() {
		kind = e.OriginalKind
	}
	redacted := Entry{ID: e.ID, Parent: e.Parent, Kind: "erasure", OriginalKind: kind, Turn: e.Turn, Step: e.Step, Call: e.Call, Job: e.Job, Copies: e.Copies, InputRef: e.InputRef, RequestRef: e.RequestRef, ContinuesTurn: e.ContinuesTurn}
	switch kind {
	case "job.start":
		redacted.JobKey = e.JobKey
		if redacted.JobKey == "" {
			redacted.JobKey = Decode[Job](e.Data).Key
		}
		if redacted.JobKey != "" {
			redacted.Writer = e.Writer
		}
	case "question.open":
		if !e.IsErased() {
			redacted.RequestRef = Decode[struct{ Question Question }](e.Data).Question.ID
		}
	case "question.answer":
		if !e.IsErased() {
			redacted.RequestRef = Decode[Answer](e.Data).Request
		}
	case "question.secret":
		if !e.IsErased() {
			redacted.RequestRef = Decode[string](e.Data)
		}
	case "turn.start":
		if !e.IsErased() {
			redacted.ContinuesTurn = Decode[TurnStart](e.Data).ContinuesTurn
		}
	}
	return redacted
}
