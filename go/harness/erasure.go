package harness

import (
	"context"
	"errors"
	"os"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// ErasureEpoch lets a delivery discard a view captured before the cutoff.
func (c *client) ErasureEpoch(id string) (int, error) {
	v, _ := c.Get("history")
	registry := api.PendingRegistry(v)
	if registry == nil || id == "" {
		return 0, nil
	}
	var epoch int
	err := registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
		for _, intent := range *intents {
			matches := false
			for _, copy := range intent.Copies {
				if copy.SessionID == id {
					matches = true
					if !copy.Complete {
						return api.ErrErasureUnavailable
					}
				}
			}
			if matches {
				epoch++
			}
		}
		return nil
	})
	return epoch, err
}

func (c *client) SupportsErasure() bool {
	v, err := c.Get("history")
	if err != nil {
		return false
	}
	return api.PendingRegistry(v) != nil
}

func (c *client) Erase(ctx context.Context, id string, ids []string) error {
	_, err := c.EraseDetails(ctx, id, ids)
	return err
}

func (c *client) EraseDetails(ctx context.Context, id string, ids []string) (api.ProviderErasure, error) {
	var report api.ProviderErasure
	v, err := c.Get("history")
	if err != nil {
		return report, api.ErrErasureUnsupported
	}
	store := v.(api.Store)
	registry := api.PendingRegistry(store)
	if registry == nil {
		return report, api.ErrErasureUnsupported
	}
	source, err := c.find(id)
	if err != nil {
		return report, err
	}
	ids = slices.Clone(ids)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	if len(ids) == 0 {
		return report, os.ErrNotExist
	}
	var operation string
	source.mu.Lock()
	err = func() error {
		if !c.authorizedBy(source.data, ctx, "erase") {
			return api.ErrAuthority
		}
		if source.pendingStore != nil {
			return os.ErrNotExist
		}
		if source.running || unfinished(source.data) || len(source.commandCancels) != 0 {
			return api.ErrErasureBusy
		}
		if err := source.checkWriterLocked(); err != nil {
			return err
		}
		return registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
			for _, previous := range *intents {
				if previous.Source == id && slices.Equal(previous.Targets, ids) {
					operation = previous.ID
					return nil
				}
			}
			all, err := store.List("")
			if err != nil {
				return errors.Join(api.ErrErasureUnavailable, err)
			}
			seen := map[string]bool{}
			for _, row := range all {
				if row.ID != id {
					continue
				}
				for _, e := range row.Entries {
					if !slices.Contains(ids, e.ID) {
						continue
					}
					if !erasable(e) {
						return api.ErrEraseForbidden
					}
					seen[e.ID] = true
				}
			}
			if len(seen) != len(ids) {
				return os.ErrNotExist
			}
			for changed := true; changed; {
				changed = false
				for _, row := range all {
					inputs := map[string]bool{}
					for _, e := range row.Entries {
						if seen[e.ID] && recordedInputID(e) != "" {
							inputs[recordedInputID(e)] = true
						}
					}
					for _, e := range row.Entries {
						if !seen[e.ID] && erasable(e) && (inputs[recordedInputID(e)] || slices.ContainsFunc(e.Copies, func(id string) bool { return seen[id] })) {
							seen[e.ID], changed = true, true
						}
					}
				}
			}
			operation = api.ID()
			intent := api.ErasureIntent{ID: operation, Source: id, Targets: ids}
			for _, row := range all {
				for _, e := range row.Entries {
					if seen[e.ID] {
						intent.Copies = append(intent.Copies, api.ErasureCopy{EntryPair: api.EntryPair{SessionID: row.ID, ID: e.ID}})
					}
				}
			}
			*intents = append(*intents, intent)
			return nil
		})
	}()
	source.mu.Unlock()
	if err != nil {
		return report, err
	}

	var intent api.ErasureIntent
	read := func() error {
		return registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
			for _, current := range *intents {
				if current.ID == operation {
					intent = current
					return nil
				}
			}
			return api.ErrErasureUnavailable
		})
	}
	if err := read(); err != nil {
		return report, err
	}
	sessions := map[string][]string{}
	for _, copy := range intent.Copies {
		sessions[copy.SessionID] = append(sessions[copy.SessionID], copy.ID)
	}
	for sessionID := range sessions {
		if current, e := c.find(sessionID); e == nil {
			current.mu.Lock()
			_ = current.reconcileErasureLocked()
			current.mu.Unlock()
		} else if lease, e := tryAcquireErasure(store, sessionID); e == nil {
			_ = registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
				row, err := lease.Load()
				if err != nil {
					return err
				}
				if running, _ := recovery(row); running != nil || unfinished(row) {
					return api.ErrErasureBusy
				}
				_, err = reconcileCopies(lease, row, intents)
				return err
			})
			_ = lease.Close()
		}
	}
	if err := read(); err != nil {
		return report, err
	}
	rows, _ := store.List("")
	visible := map[string]bool{id: true}
	for _, row := range rows {
		visible[row.ID] = row.ID == id || c.authorizedBy(row, ctx, "watch")
	}
	for _, copy := range intent.Copies {
		switch {
		case !visible[copy.SessionID]:
			report.OutOfReach = append(report.OutOfReach, "copies in other sessions")
		case copy.Complete:
			report.ErasedPairs = append(report.ErasedPairs, copy.EntryPair)
		default:
			report.PendingPairs = append(report.PendingPairs, copy.EntryPair)
		}
	}
	for sessionID, targets := range sessions {
		for _, value := range c.All("provider.") {
			provider := value.(api.Provider)
			if !slices.ContainsFunc(provider.Catalog(), func(m api.Model) bool { return m.Stateful }) {
				continue
			}
			eraser, ok := provider.(api.ProviderEraser)
			if !ok {
				report.OutOfReach = append(report.OutOfReach, "Provider remote copies")
				continue
			}
			answer, err := eraser.EraseState(ctx, sessionID, targets)
			if err != nil || len(answer.Pending) != 0 {
				report.OutOfReach = append(report.OutOfReach, "unconfirmed Provider deletion")
			}
			report.OutOfReach = append(report.OutOfReach, answer.OutOfReach...)
		}
	}
	slices.Sort(report.OutOfReach)
	report.OutOfReach = slices.Compact(report.OutOfReach)
	return report, nil
}

func tryAcquireErasure(store api.Store, id string) (api.Lease, error) {
	if store, ok := store.(interface {
		TryAcquire(string) (api.Lease, error)
	}); ok {
		return store.TryAcquire(id)
	}
	return store.Acquire(id)
}

func erasable(e api.Entry) bool {
	return !e.AuthorityRecord() && e.Kind != "position" && (e.Kind != "erasure" || e.IsErased())
}

func (s *session) erasureCoordinator() api.ErasureCoordinator {
	if s.h == nil {
		return nil
	}
	v, _ := s.h.API().Get("history")
	return api.PendingRegistry(v)
}

// Called with the session lock before use. Existing live work cannot continue
// to read its cached view once the registry marks any of its session's content.
func (s *session) reconcileErasureLocked() error {
	registry := s.erasureCoordinator()
	if registry == nil {
		return nil
	}
	return registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
		if !needsErasure(s.data, *intents) {
			return nil
		}
		if s.running || unfinished(s.data) || len(s.commandCancels) != 0 {
			if s.cancel != nil {
				s.cancel(api.ErrProcessStopped)
			}
			return api.ErrErasureUnavailable
		}
		if s.lease == nil {
			return api.ErrErasureUnavailable
		}
		if interrupted, _ := recovery(s.data); interrupted != nil {
			return api.ErrErasureUnavailable
		}
		old := s.data
		actual, err := s.lease.Load()
		if err != nil {
			return errors.Join(api.ErrErasureUnavailable, err)
		}
		snap, err := reconcileCopies(s.lease, actual, intents)
		if err != nil {
			return errors.Join(api.ErrErasureUnavailable, err)
		}
		if needsErasure(snap, *intents) {
			return api.ErrErasureUnavailable
		}
		s.data, s.last = snap, recordedOutcome(snap)
		_, queue := recovery(snap)
		s.queue = slices.DeleteFunc(queue, parked)
		if s.h != nil && s.h.capacity != nil {
			p := s.h.capacity
			p.mu.Lock()
			if old.ID == snap.ID {
				p.update(snap, snapshotCharges(snap))
			}
			p.mu.Unlock()
		}
		return nil
	})
}

func needsErasure(row api.Session, intents []api.ErasureIntent) bool {
	for _, intent := range intents {
		for _, copy := range intent.Copies {
			if copy.SessionID == row.ID && (!copy.Complete || slices.ContainsFunc(row.Entries, func(e api.Entry) bool { return e.ID == copy.ID && !e.IsErased() })) {
				return true
			}
		}
	}
	return false
}

func reconcileCopies(lease api.Lease, snap api.Session, intents *[]api.ErasureIntent) (api.Session, error) {
	exact, ok := lease.(api.ExactErasureLease)
	if !ok {
		return snap, api.ErrErasureUnsupported
	}
	for _, intent := range *intents {
		var ids []string
		for _, copy := range intent.Copies {
			if copy.SessionID == snap.ID {
				ids = append(ids, copy.ID)
			}
		}
		if len(ids) == 0 {
			continue
		}
		record := api.ErasureRecord{EntryIDs: ids}
		for _, e := range snap.Entries {
			if e.Kind == "input.accepted" && slices.Contains(ids, e.ID) {
				in := api.Decode[api.Input](e.Data)
				if in.Key != "" {
					record.InputKeys = append(record.InputKeys, api.ErasedInputKey{InputID: in.ID, Key: in.Key, ActorID: in.Actor, SubmittedBy: in.ViaActor})
				}
			}
		}
		bookkeeping := intent.ID + "-" + snap.ID // distinct, stable per-session identity
		if !slices.ContainsFunc(snap.Entries, func(e api.Entry) bool { return e.ID == bookkeeping && e.Kind == "erasure" && !e.IsErased() }) {
			snap.Entries = slices.Clip(snap.Entries)
			appendEntry(&snap, api.Entry{ID: bookkeeping, Kind: "erasure", Data: api.JSON(record)}, "harness", true)
			if err := lease.Save(snap); err != nil {
				return snap, err
			}
		}
		next := snap
		next.Entries = slices.Clone(snap.Entries)
		changed := false
		for i, e := range next.Entries {
			if slices.Contains(ids, e.ID) && !e.IsErased() && erasable(e) {
				next.Entries[i], changed = e.Redacted(), true
			}
		}
		if changed {
			if err := exact.SaveErasure(next); err != nil {
				return snap, err
			}
		}
		var err error
		snap, err = lease.Load()
		if err != nil {
			return snap, err
		}
		for i, copy := range intent.Copies {
			if copy.SessionID == snap.ID && slices.ContainsFunc(snap.Entries, func(e api.Entry) bool { return e.ID == copy.ID && e.IsErased() }) {
				intent.Copies[i].Complete = true
			}
		}
	}
	return snap, nil
}

// Prevent publication of a stale fork or new copy after the erasure cutoff.
// The check and the save are ordered by the same registry lock as publication.
func (s *session) withErasureCheck(next api.Session, save func(string) error) error {
	registry := s.erasureCoordinator()
	if registry == nil {
		return save("")
	}
	check := func(intents []api.ErasureIntent, guard string) error {
		if needsErasure(s.data, intents) {
			return api.ErrErasureUnavailable
		}
		if len(intents) != 0 {
			start := len(s.data.Entries)
			if next.ForkedFrom != s.data.ForkedFrom {
				start = 0
			}
			for _, entry := range next.Entries[min(start, len(next.Entries)):] {
				for _, intent := range intents {
					for _, copy := range intent.Copies {
						if slices.Contains(entry.Copies, copy.ID) {
							return api.ErrErasureUnavailable
						}
					}
				}
			}
		}
		return save(guard)
	}
	if remote, ok := registry.(api.RemoteErasureCoordinator); ok {
		return remote.GuardErasure(check)
	}
	return registry.PendingErasures(func(intents *[]api.ErasureIntent) error { return check(*intents, "") })
}

func guardedSave(lease api.Lease, next api.Session, guard string) error {
	if guard == "" {
		return lease.Save(next)
	}
	if lease, ok := lease.(api.GuardedErasureLease); ok {
		return lease.SaveGuarded(next, guard)
	}
	return api.ErrErasureUnavailable
}
