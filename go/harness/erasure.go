package harness

import (
	"context"
	"errors"
	"os"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/runreceipt"
)

// ErasureEpoch lets a delivery discard a view captured before the cutoff.
func (c *client) ErasureEpoch(id string) (int, error) {
	v, _ := c.Get("history")
	if id != "" {
		if remote := api.RemoteRegistry(v); remote != nil {
			// An unpersisted session cannot have plans. Do not make a missing
			// durable session look like a provisional one.
			s, _ := c.find(id)
			if s != nil && s.provisional.Load() {
				return 0, nil
			}
			plans, _, err := remote.ErasurePlans(id)
			if err != nil {
				return 0, err
			}
			if len(plans) != 0 {
				var tombstones map[string]bool
				if s != nil {
					if seen := s.erasureTombstones.Load(); seen != nil {
						tombstones = *seen
					}
				} else {
					// A read on a closed session cannot open a writer to check a plan.
					rows, err := v.(api.Store).List("")
					if err != nil {
						return 0, errors.Join(api.ErrErasureUnavailable, err)
					}
					for _, row := range rows {
						if row.ID == id {
							tombstones = erasureTombstones(row)
							break
						}
					}
				}
				if err := checkRemotePlans(plans, tombstones); err != nil {
					return 0, err
				}
			}
			return len(plans), nil
		}
	}
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
						return errors.Join(api.ErrPendingErasure, api.ErrErasureUnavailable)
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

func (c *client) RetryPendingErasure(ctx context.Context, id, right string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !c.authorizedBy(s.data, ctx, right) {
		return api.ErrAuthority
	}
	return s.reconcileErasureLocked()
}

func (c *client) SupportsErasure() bool {
	v, err := c.Get("history")
	if err != nil {
		return false
	}
	return api.PendingRegistry(v) != nil || api.RemoteRegistry(v) != nil && len(c.statefulErasureProviders()) == 0
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
	remote := api.RemoteRegistry(store)
	if registry == nil && (remote == nil || len(c.statefulErasureProviders()) != 0) {
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
	if remote != nil {
		return c.eraseRemote(ctx, store, remote, source, ids)
	}
	providers := c.statefulErasureProviders()
	var operation string
	source.mu.Lock()
	err = func() error {
		if !c.authorizedBy(source.data, ctx, "erase") {
			return api.ErrAuthority
		}
		if source.pendingStore != nil {
			return os.ErrNotExist
		}
		if source.running || unfinishedBesidesInterfaces(source.data) || len(source.commandCancels) != 0 {
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
			intent, err := discoverErasure(store, id, ids)
			if err != nil {
				return err
			}
			operation = intent.ID
			seenSessions := map[string]bool{}
			for _, copy := range intent.Copies {
				if seenSessions[copy.SessionID] {
					continue
				}
				seenSessions[copy.SessionID] = true
				for provider := range providers {
					intent.Providers = append(intent.Providers, api.ErasureProvider{SessionID: copy.SessionID, Provider: provider})
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
		} else if lease, e := tryAcquireHistory(store, sessionID); e == nil {
			_ = registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
				row, err := lease.Load()
				if err != nil {
					return err
				}
				_, err = reconcileCopyRecords(lease, row, *intents, nil, c.h.receiptDir)
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
			for _, row := range rows {
				if row.ID == copy.SessionID && affectedInterfaceCopy(row, copy.ID) {
					report.OutOfReach = append(report.OutOfReach, interfaceCopyNotice)
					break
				}
			}
			report.ErasedPairs = append(report.ErasedPairs, copy.EntryPair)
		default:
			report.PendingPairs = append(report.PendingPairs, copy.EntryPair)
		}
	}
	report.OutOfReach = append(report.OutOfReach, c.retryProviderDeletion(ctx, registry, intent, providers)...)
	slices.Sort(report.OutOfReach)
	report.OutOfReach = slices.Compact(report.OutOfReach)
	return report, nil
}

func tryAcquireHistory(store api.Store, id string) (api.Lease, error) {
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
	if remote := s.remoteErasureCoordinator(); remote != nil {
		return s.reconcileRemoteErasureLocked(remote)
	}
	registry := s.erasureCoordinator()
	if registry == nil {
		return nil
	}
	return registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
		if !needsErasure(s.data, *intents) {
			return nil
		}
		if s.running || (!s.opening && hasUnfinishedJobs(s.data)) || len(s.commandCancels) != 0 {
			if s.cancel != nil {
				s.cancel(api.ErrProcessStopped)
			}
			for pending := range s.commandCancels {
				pending.cancel(api.ErrProcessStopped)
			}
			return api.ErrErasureUnavailable
		}
		if s.lease == nil {
			return api.ErrErasureUnavailable
		}
		old := s.data
		actual, err := s.lease.Load()
		if err != nil {
			return errors.Join(api.ErrErasureUnavailable, err)
		}
		snap, err := reconcileCopyRecords(s.lease, actual, *intents, nil, s.h.receiptDir)
		if err != nil {
			return errors.Join(api.ErrErasureUnavailable, err)
		}
		if needsErasure(snap, *intents) {
			return api.ErrErasureUnavailable
		}
		s.data, s.last = snap, recordedOutcome(snap)
		s.storageCharges = nil
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
			if copy.SessionID == row.ID && (!copy.Complete || !slices.ContainsFunc(row.Entries, func(e api.Entry) bool { return e.ID == copy.ID && e.IsErased() })) {
				return true
			}
		}
	}
	return false
}

func reconcileCopies(lease api.Lease, snap api.Session, intents *[]api.ErasureIntent) (api.Session, error) {
	return reconcileCopyRecords(lease, snap, *intents, nil, "")
}

func reconcileCopyRecords(lease api.Lease, snap api.Session, intents []api.ErasureIntent, records map[string]string, receiptDir string) (api.Session, error) {
	exact, ok := lease.(api.ExactErasureLease)
	if !ok {
		return snap, api.ErrErasureUnsupported
	}
	save := lease.Save
	if l, ok := lease.(interface{ SaveErasureRecords(api.Session) error }); ok {
		save = l.SaveErasureRecords
	}
	if needsErasure(snap, intents) {
		settled := settleForErasure(snap)
		if len(settled.Entries) > len(snap.Entries) {
			if err := save(settled); err != nil {
				return snap, err
			}
			snap = settled
		}
	}
	for _, intent := range intents {
		var ids []string
		for _, copy := range intent.Copies {
			if copy.SessionID == snap.ID {
				ids = append(ids, copy.ID)
			}
		}
		if len(ids) == 0 {
			continue
		}
		if err := runreceipt.Erase(receiptDir, snap, ids); err != nil {
			return snap, err
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
		bookkeeping := records[intent.ID]
		if bookkeeping == "" {
			bookkeeping = intent.ID + "-" + snap.ID
		}
		if !slices.ContainsFunc(snap.Entries, func(e api.Entry) bool { return e.ID == bookkeeping && e.Kind == "erasure" && !e.IsErased() }) {
			snap.Entries = slices.Clip(snap.Entries)
			appendEntry(&snap, api.Entry{ID: bookkeeping, Kind: "erasure", Data: api.JSON(record)}, "harness", true)
			if err := save(snap); err != nil {
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
		load := lease.Load
		if l, ok := lease.(api.RemoteErasureLease); ok {
			load = l.LoadErasure
		}
		snap, err = load()
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
func (s *session) withErasureCheck(next api.Session, save func() error) error {
	registry := s.erasureCoordinator()
	if registry == nil {
		return save()
	}
	check := func(intents []api.ErasureIntent) error {
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
		return save()
	}
	return registry.PendingErasures(func(intents *[]api.ErasureIntent) error { return check(*intents) })
}
