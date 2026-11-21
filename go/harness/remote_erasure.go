package harness

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
)

func discoverErasure(store api.Store, source string, ids []string) (api.ErasureIntent, error) {
	all, err := store.List("")
	if err != nil {
		return api.ErasureIntent{}, errors.Join(api.ErrErasureUnavailable, err)
	}
	selected := map[api.EntryPair]bool{}
	locations := map[string]map[string]bool{}
	for _, row := range all {
		for _, e := range row.Entries {
			if locations[e.ID] == nil {
				locations[e.ID] = map[string]bool{}
			}
			locations[e.ID][row.ID] = true
		}
	}
	for _, row := range all {
		if row.ID != source {
			continue
		}
		for _, e := range row.Entries {
			if slices.Contains(ids, e.ID) {
				if !erasable(e) {
					return api.ErasureIntent{}, api.ErrEraseForbidden
				}
				selected[api.EntryPair{SessionID: source, ID: e.ID}] = true
			}
		}
	}
	if len(selected) != len(ids) {
		return api.ErasureIntent{}, os.ErrNotExist
	}
	for changed := true; changed; {
		changed = false
		for _, row := range all {
			inputs := map[string]bool{}
			for _, e := range row.Entries {
				if selected[api.EntryPair{SessionID: row.ID, ID: e.ID}] && recordedInputID(e) != "" {
					inputs[recordedInputID(e)] = true
				}
			}
			origin, _, prefix := strings.Cut(row.ForkedFrom, ":")
			for _, e := range row.Entries {
				pair := api.EntryPair{SessionID: row.ID, ID: e.ID}
				prefix = prefix && (len(e.Copies) != 0 || e.IsErased())
				from := row.ID
				if prefix {
					from = origin
				}
				copied := slices.ContainsFunc(e.Copies, func(id string) bool {
					if prefix || locations[id][from] {
						return selected[api.EntryPair{SessionID: from, ID: id}]
					}
					// Go job results also carry the child's source IDs.
					// Follow those references when no local source exists.
					for sid := range locations[id] {
						if selected[api.EntryPair{SessionID: sid, ID: id}] {
							return true
						}
					}
					return false
				})
				if !selected[pair] && erasable(e) && (inputs[recordedInputID(e)] || copied) {
					selected[pair], changed = true, true
				}
			}
		}
	}
	intent := api.ErasureIntent{ID: api.ID(), Source: source, Targets: ids}
	for _, row := range all {
		for _, e := range row.Entries {
			pair := api.EntryPair{SessionID: row.ID, ID: e.ID}
			if selected[pair] {
				intent.Copies = append(intent.Copies, api.ErasureCopy{EntryPair: pair})
			}
		}
	}
	return intent, nil
}

func (c *client) eraseRemote(ctx context.Context, store api.Store, remote api.RemoteErasureCoordinator, source *session, ids []string) (report api.ProviderErasure, err error) {
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
		writer, ok := source.lease.(api.RemoteErasureLease)
		if !ok {
			return api.ErrErasureUnsupported
		}
		_, revision, err := remote.ErasurePlans(source.id)
		if err != nil {
			return err
		}
		intent, err := discoverErasure(store, source.id, ids)
		if err != nil {
			return err
		}
		operation, err = writer.PublishErasure(revision, intent)
		return err
	}()
	source.mu.Unlock()
	if err != nil {
		return report, err
	}

	rows, err := store.List("")
	if err != nil {
		return report, errors.Join(api.ErrErasureUnavailable, err)
	}
	for _, row := range rows {
		plans, _, err := remote.ErasurePlans(row.ID)
		if err != nil {
			return report, err
		}
		if !slices.ContainsFunc(plans, func(p api.ErasurePlan) bool { return p.IntentID == operation }) {
			continue
		}
		if current, err := c.find(row.ID); err == nil {
			current.mu.Lock()
			_ = current.reconcileRemoteErasureLocked(remote)
			current.mu.Unlock()
		} else if lease, err := tryAcquireErasure(store, row.ID); err == nil {
			if writer, ok := lease.(api.RemoteErasureLease); ok {
				if actual, err := writer.LoadErasure(); err == nil {
					// Read again with writer access; the earlier read only
					// selected a session to try.
					if current, _, err := remote.ErasurePlans(row.ID); err == nil {
						_, _ = completeRemoteCopies(lease, actual, current)
					}
				}
			}
			_ = lease.Close()
		}
		plans, _, err = remote.ErasurePlans(row.ID)
		if err != nil {
			return report, err
		}
		for _, plan := range plans {
			if plan.IntentID != operation {
				continue
			}
			if row.ID != source.id && !c.authorizedBy(row, ctx, "watch") {
				report.OutOfReach = []string{"copies in other sessions"}
				continue
			}
			for _, copy := range plan.Copies {
				if copy.Complete {
					report.ErasedPairs = append(report.ErasedPairs, copy.EntryPair)
				} else {
					report.PendingPairs = append(report.PendingPairs, copy.EntryPair)
				}
			}
		}
	}
	return report, nil
}

func (s *session) remoteErasureCoordinator() api.RemoteErasureCoordinator {
	if s.h == nil {
		return nil
	}
	v, _ := s.h.API().Get("history")
	return api.RemoteRegistry(v)
}

func (s *session) reconcileRemoteErasureLocked(remote api.RemoteErasureCoordinator) error {
	if s.provisional.Load() {
		return nil
	}
	plans, _, err := remote.ErasurePlans(s.id)
	if err != nil {
		return err
	}
	if len(plans) == 0 {
		return nil
	}
	if cached := s.erasureTombstones.Load(); cached != nil && checkRemotePlans(plans, *cached) == nil {
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
	writer, ok := s.lease.(api.RemoteErasureLease)
	if !ok {
		return api.ErrErasureUnavailable
	}
	actual, err := writer.LoadErasure()
	if err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	snap, err := completeRemoteCopies(s.lease, actual, plans)
	if err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	// Admit this view only after re-reading marks for the prepared snapshot.
	plans, _, err = remote.ErasurePlans(s.id)
	if err != nil {
		return err
	}
	tombstones := erasureTombstones(snap)
	if err := checkRemotePlans(plans, tombstones); err != nil {
		return err
	}
	snap, err = s.lease.Load()
	if err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	s.data, s.last = snap, recordedOutcome(snap)
	_, queue := recovery(snap)
	s.queue = slices.DeleteFunc(queue, parked)
	if s.h.capacity != nil {
		p := s.h.capacity
		p.mu.Lock()
		p.update(snap, snapshotCharges(snap))
		p.mu.Unlock()
	}
	s.erasureTombstones.Store(&tombstones)
	return nil
}

func listRemoteViews(remote api.RemoteErasureCoordinator, rows []api.Session) ([]api.Session, error) {
	var revision string
	var visible []api.Session
	for _, row := range rows {
		plans, rev, err := remote.ErasurePlans(row.ID)
		if err != nil || revision != "" && rev != revision {
			return nil, errors.Join(api.ErrErasureUnavailable, err)
		}
		revision = rev
		if checkRemotePlans(plans, erasureTombstones(row)) != nil {
			// Keep only routing and authority facts. ACP must be able to
			// authorize an open so a later writer can settle the plan.
			row = erasureRoutingView(row)
		}
		visible = append(visible, row)
	}
	return visible, nil
}

func erasureRoutingView(row api.Session) api.Session {
	out := api.Session{ID: row.ID, Version: row.Version, Project: row.Project, Tenant: row.Tenant,
		Actor: row.Actor, Actors: row.Actors, Limit: row.Limit, Parent: row.Parent, ParentActor: row.ParentActor,
		Ceiling: row.Ceiling, Depth: row.Depth, Settings: api.Settings{Model: row.Settings.Model}}
	for _, e := range row.Entries {
		switch e.Kind {
		case "actor.set", "actor.left", "subagent.bound":
			if e.AuthorityRecord() {
				out.Entries = append(out.Entries, api.Entry{Kind: e.Kind, Data: e.Data, Time: e.Time})
			}
		}
	}
	return out
}

func (s *session) admitErasureView(snap api.Session) error {
	if remote := s.remoteErasureCoordinator(); remote != nil && !s.provisional.Load() {
		return admitRemoteView(remote, snap)
	}
	return nil
}

func admitRemoteView(remote api.RemoteErasureCoordinator, snap api.Session) error {
	tombstones := erasureTombstones(snap)
	plans, _, err := remote.ErasurePlans(snap.ID)
	if err != nil {
		return err
	}
	return checkRemotePlans(plans, tombstones)
}

func (c *client) admitForkView(snap api.Session) error {
	v, _ := c.Get("history")
	if remote := api.RemoteRegistry(v); remote != nil {
		return admitRemoteView(remote, snap)
	}
	return nil
}

func (s *session) invokeWithErasureView(ctx context.Context, name string, snap api.Session, input any) (any, error) {
	if err := s.admitErasureView(snap); err != nil {
		return nil, err
	}
	return s.h.API().Invoke(ctx, name, input)
}

func erasureTombstones(snap api.Session) map[string]bool {
	out := map[string]bool{}
	for _, e := range snap.Entries {
		if e.IsErased() {
			out[e.ID] = true
		}
	}
	return out
}

func checkRemotePlans(plans []api.ErasurePlan, tombstones map[string]bool) error {
	for _, p := range plans {
		for _, copy := range p.Copies {
			if !copy.Complete || !tombstones[copy.ID] {
				return api.ErrErasureUnavailable
			}
		}
	}
	return nil
}

func completeRemoteCopies(lease api.Lease, snap api.Session, plans []api.ErasurePlan) (api.Session, error) {
	writer, ok := lease.(api.RemoteErasureLease)
	if !ok {
		return snap, api.ErrErasureUnsupported
	}
	for _, p := range plans {
		tombstones := erasureTombstones(snap)
		var pending []string
		for _, copy := range p.Copies {
			if copy.Complete && !tombstones[copy.ID] {
				return snap, api.ErrErasureUnavailable
			}
			if !copy.Complete {
				pending = append(pending, copy.ID)
			}
		}
		if len(pending) == 0 {
			continue
		}
		intent := api.ErasureIntent{ID: p.IntentID, Source: p.SourceID, Copies: p.Copies}
		var err error
		snap, err = reconcileCopyRecords(lease, snap, []api.ErasureIntent{intent}, map[string]string{intent.ID: p.RecordID})
		if err != nil {
			return snap, err
		}
		tombstones = erasureTombstones(snap)
		verified := slices.DeleteFunc(pending, func(id string) bool { return !tombstones[id] })
		if len(verified) != 0 {
			if err := writer.CompleteErasure(p.IntentID, verified); err != nil {
				return snap, err
			}
		}
	}
	return snap, nil
}
