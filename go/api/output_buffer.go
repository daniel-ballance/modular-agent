package api

// OutputBuffer accounts for a retained recipient view. A nil release means
// the optional output did not fit. The caller must release every admitted view.
type OutputBuffer interface {
	ReserveOutput(Event) func()
}

// BufferedEvent owns its charge until delivery or discard.
type BufferedEvent struct {
	Event
	Release func()
}

func BufferEvent(host any, e Event) (BufferedEvent, bool) {
	release := func() {}
	if owner, ok := host.(OutputBuffer); ok {
		release = owner.ReserveOutput(e)
		if release == nil {
			return BufferedEvent{}, false
		}
	}
	return BufferedEvent{Event: e, Release: release}, true
}
