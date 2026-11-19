package api

// HandedBackIDs reads a batch of returned input, or the old single-id record.
func (e Entry) HandedBackIDs() []string {
	if !e.WasKind("input.returned") && !e.WasKind("input.withdrawn") {
		return nil
	}
	if e.InputRef != "" {
		return []string{e.InputRef}
	}
	if e.InputRefs != nil {
		return e.InputRefs
	}
	if ids := Decode[[]string](e.Data); ids != nil {
		return ids
	}
	if id := Decode[string](e.Data); id != "" {
		return []string{id}
	}
	return []string{}
}

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
	redacted := Entry{ID: e.ID, Parent: e.Parent, Kind: "erasure", OriginalKind: kind, Turn: e.Turn, Step: e.Step, Call: e.Call, Job: e.Job, Copies: e.Copies, InputRef: e.InputRef, InputRefs: e.InputRefs}
	switch kind {
	case "job.start":
		redacted.JobKey = e.JobKey
		if redacted.JobKey == "" {
			redacted.JobKey = Decode[Job](e.Data).Key
		}
		if redacted.JobKey != "" {
			redacted.Writer = e.Writer
		}
	case "input":
		redacted.InputRef = e.InputID()
	case "input.accepted":
		if redacted.InputRef == "" {
			redacted.InputRef = Decode[Input](e.Data).ID
		}
	case "input.returned", "input.withdrawn":
		if redacted.InputRef == "" {
			redacted.InputRefs = e.HandedBackIDs()
		}
	}
	return redacted
}
