package harness

import (
	"context"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
)

// PendingInterfaceCall is status for this route, not an executable delivery.
type PendingInterfaceCall struct {
	CallID, TurnID string
	Deadline       int64
	Reportable     bool
}

func (i *InterfaceConnection) Pending() ([]PendingInterfaceCall, error) {
	s := i.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileErasureLocked(); err != nil {
		return nil, err
	}
	if err := s.checkWriterLocked(); err != nil {
		return nil, err
	}
	var out []PendingInterfaceCall
	for _, cp := range s.data.Branch() {
		if cp.Kind != api.InterfaceHandoffKind || interfaceTerminal(s.data, cp.Call).ID != "" {
			continue
		}
		_, saved, ok := i.c.h.restoreInterface(s.data, cp)
		if !ok || saved.Actor != i.actor || saved.Route != i.route || !i.allowedLocked("watch", saved.Rights) || !i.allowedLocked("tools", saved.Rights) || saved.Deadline <= worktime.Now().UnixMilli() {
			continue
		}
		ended := slices.ContainsFunc(s.data.Branch(), func(e api.Entry) bool {
			return e.Kind == "turn.end" && e.Turn == cp.Turn && api.Decode[api.Outcome](e.Data).Status == "completed"
		})
		out = append(out, PendingInterfaceCall{cp.Call, cp.Turn, saved.Deadline, ended && !s.interfaceUnreleased[cp.Call]})
	}
	return out, nil
}

// ReleaseGroup checks every live ticket before authorizing any call in a terminal group.
// callers must be the committed, gated calls of a completed turn, in call order.
func (i *InterfaceConnection) ReleaseGroup(ctx context.Context, turn string, callers []api.Call) error {
	return i.checkGroup(ctx, turn, callers, true)
}
func (i *InterfaceConnection) CheckGroup(ctx context.Context, turn string, callers []api.Call) error {
	return i.checkGroup(ctx, turn, callers, false)
}
func (i *InterfaceConnection) checkGroup(ctx context.Context, turn string, callers []api.Call, release bool) error {
	s := i.s
	s.mu.Lock()
	tickets := make([]stagedInterfaceCall, len(callers))
	for n, call := range callers {
		cp := api.InterfaceHandoffs(s.data)[call.ID]
		ticket, ok := i.staged[cp.ID]
		if !ok || cp.Turn != turn {
			s.mu.Unlock()
			return api.ErrAuthority
		}
		tickets[n] = ticket
	}
	s.mu.Unlock()
	for n, t := range tickets {
		if t.validate != nil && t.validate(callers[n]) != nil {
			return api.ErrAuthority
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileErasureLocked(); err != nil {
		return err
	}
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if !slices.ContainsFunc(s.data.Branch(), func(e api.Entry) bool {
		return e.Kind == "turn.end" && e.Turn == turn && api.Decode[api.Outcome](e.Data).Status == "completed"
	}) {
		return api.ErrAuthority
	}
	for n, t := range tickets {
		c, saved, ok := i.c.h.restoreInterface(s.data, t.entry)
		if !ok || i.staged[t.entry.ID].entry.ID == "" || saved.Deadline <= worktime.Now().UnixMilli() || !i.canReceiveLocked(i.c.h.interfaceTools[c.Name], c.Name) || !t.ports.canRunToolsLocked(c.Actor) || interfaceTerminal(s.data, c.ID).ID != "" || c.ID != callers[n].ID || c.Name != callers[n].Name || string(c.Input) != string(callers[n].Input) {
			return api.ErrAuthority
		}
	}
	return s.withErasureCheck(s.data, func() error {
		if !release {
			return nil
		}
		for _, t := range tickets {
			delete(i.staged, t.entry.ID)
			delete(s.interfaceUnreleased, t.entry.Call)
		}
		return nil
	})
}
