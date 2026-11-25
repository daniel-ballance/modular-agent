package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"sort"
	"time"
)

func (c *client) Fork(ctx context.Context, id, target string) (string, error) {
	s, err := c.find(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if err := s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return "", err
	}
	snap := s.data
	running := s.running
	allowed := c.authorizedBy(snap, ctx, "input") && c.authorizedBy(snap, ctx, "settings")
	s.mu.Unlock()
	if !allowed {
		return "", api.ErrAuthority
	}
	if running {
		return "", api.ErrUnfinishedWork
	}
	if unfinished(snap) {
		return "", api.ErrUnfinishedWork
	}
	if target != "" {
		snap.Position = target
	}
	found := snap.Position == ""
	for _, e := range snap.Entries {
		if e.ID == snap.Position {
			found = true
		}
	}
	if !found {
		return "", errors.New("unknown fork position")
	}
	if unfinished(snap) {
		return "", errors.New("fork target has unfinished calls or jobs")
	}
	if pending, _ := recovery(snap); pending != nil {
		return "", errors.New("fork target is inside a turn; choose a completed boundary")
	}
	fork, err := c.newSession(ctx, snap.Project, snap.Tenant, snap.Limit, true, nil, nil)
	if err != nil {
		return "", err
	}
	s, _ = c.find(fork)
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	next.Settings = snap.Settings
	next.Actors = clone(actors(snap))
	next.Actor = snap.Actor
	next.Parent, next.ParentActor, next.Ceiling, next.Depth = snap.Parent, snap.ParentActor, snap.Ceiling, snap.Depth
	next.ForkedFrom = id + ":" + snap.Position
	next.Entries = nil
	parent := ""
	mapping := map[string]string{}
	for _, e := range snap.Branch() {
		if e.IsErased() || e.Kind == "position" || e.Kind == "tenant" || e.Kind == "limit" || e.Kind == "erasure" || e.Kind == telemetry.TurnTrace || e.Kind == api.InterfaceHandoffKind {
			continue
		}
		if e.Kind == "turn.start" {
			start := api.Decode[api.TurnStart](e.Data)
			start.TraceContext = nil
			e.Data = api.JSON(start)
		}
		e = portable.WithoutApprovalView(e)
		source := e.ID
		e.ID = api.ID()
		mapping[source] = e.ID
		e.Session = fork
		e.Parent = parent
		e.Copies = []string{source}
		next.Entries = append(next.Entries, e)
		parent = e.ID
	}
	appendSetup := func(kind string, data any) {
		e := api.Entry{ID: api.ID(), Parent: parent, Session: fork, Kind: kind, Actor: api.Acting(ctx), Writer: "harness", Time: time.Now().UTC(), Data: api.JSON(data)}
		next.Entries, parent = append(next.Entries, e), e.ID
	}
	if snap.Tenant != "" {
		appendSetup("tenant", snap.Tenant)
	}
	seen := map[string]bool{}
	for _, e := range snap.Entries {
		if e.Kind == "actor.left" {
			who := api.Decode[string](e.Data)
			if _, stillMember := next.Actors[who]; !stillMember && !seen[who] {
				appendSetup("actor.left", who)
				seen[who] = true
			}
		}
	}
	actorIDs := make([]string, 0, len(next.Actors))
	for who := range next.Actors {
		actorIDs = append(actorIDs, who)
	}
	sort.Strings(actorIDs)
	for _, who := range actorIDs {
		appendSetup("actor.set", next.Actors[who])
	}
	appendSetup("setting", next.Settings)
	if snap.Limit != nil {
		appendSetup("limit", *snap.Limit)
	}
	appendSetup("plugins.set", next.Plugins)
	next.Position = parent
	// Metadata belongs to its plugin. Invoke outside the session lock.
	s.mu.Unlock()
	var transformed any
	hookErr := c.admitForkView(snap)
	if hookErr == nil {
		transformed, hookErr = c.h.API().Invoke(ctx, "session.fork", api.Forked{Session: next, Mapping: mapping})
	}
	s.mu.Lock()
	if hookErr == nil {
		next = transformed.(api.Forked).Session
		hookErr = s.publishInitialLocked(next)
	}
	if hookErr != nil {
		s.mu.Unlock()
		_ = c.CloseSession(fork)
		s.mu.Lock()
		return "", hookErr
	}
	return fork, nil
}
