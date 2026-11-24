package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"maps"
	"slices"
)

func actors(s api.Session) map[string]api.Actor {
	if s.Actors != nil {
		return s.Actors
	}
	return map[string]api.Actor{s.Actor: {ID: s.Actor, Kind: "user", Rights: append([]string(nil), api.Rights...)}}
}
func (c *client) Authorize(id, who, right string) bool {
	// A recorded right unknown to this build remains in history but grants nothing.
	if !slices.Contains(api.Rights, right) {
		return false
	}
	snap, err := c.Snapshot(id)
	if err != nil {
		return false
	}
	return c.authorized(snap, who, right)
}

// DiscoverForHost applies the existing open admission check without joining.
func (c *client) DiscoverForHost(snap api.Session, host api.Actor) bool {
	return c.authorized(viewForHost(snap, host), host.ID, "watch")
}

func viewForHost(snap api.Session, host api.Actor) api.Session {
	if !recordedHost(snap, host.ID) {
		snap.Actors = maps.Clone(actors(snap))
		snap.Actors[host.ID] = host
	}
	return snap
}

func (c *client) authorized(snap api.Session, who, right string) bool {
	if snap.Limit != nil && right != "administer" && !slices.Contains(*snap.Limit, right) {
		return false
	}
	if snap.Tenant != "" {
		tenant, ok := c.h.tenants[snap.Tenant]
		if !ok || !slices.Contains(tenant.Rights, right) {
			return false
		}
	}
	ancestors := jobAncestors(snap, who, right)
	if len(ancestors) == 0 || !slices.Contains(api.Rights, right) {
		return false
	}
	for _, id := range ancestors {
		a, ok := actors(snap)[id]
		if !ok || !slices.Contains(a.Rights, right) {
			return false
		}
	}
	if snap.Parent != "" {
		return slices.Contains(snap.Ceiling, right) && c.Authorize(snap.Parent, snap.ParentActor, right)
	}
	return true
}
func (c *client) authorizedBy(s api.Session, ctx context.Context, right string) bool {
	via := api.ActingVia(ctx)
	return api.SessionScopeAllows(ctx, s.Project, s.Tenant) && api.ConnectionAllows(ctx, right) && c.authorized(s, api.Acting(ctx), right) && (via == "" || c.authorized(s, via, right))
}
func (c *client) Grant(ctx context.Context, id string, actor api.Actor) error {
	who := api.Acting(ctx)
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !c.authorizedBy(s.data, ctx, "grant") || actor.ID == "" {
		return api.ErrAuthority
	}
	for _, r := range actor.Rights {
		if slices.Contains(api.Rights, r) && !c.authorizedBy(s.data, ctx, r) {
			return api.ErrAuthority
		}
	}
	err = s.joinActorLocked(who, actor, c.owner)
	if err == nil {
		s.mu.Unlock()
		c.actorChanged(ctx, "session.join", id, actor, who)
		s.mu.Lock()
	}
	return err
}

func (s *session) joinActorLocked(who string, actor api.Actor, writer string) error {
	next := clone(s.data)
	next.Actors = actors(next)
	next.Actors[actor.ID] = actor
	return s.updateActorsLocked(next, api.Entry{Kind: "actor.set", Actor: who, OperatorAdmission: who == "", Data: api.JSON(actor)}, writer)
}

func (s *session) updateActorsLocked(next api.Session, event api.Entry, writer string) error {
	old := s.data
	s.data = next
	_, err := s.recordLocked(event, writer, true)
	if err != nil {
		s.data = old
	} else if s.h != nil {
		err = s.h.afterApprovalChangeLocked(context.Background(), s)
	}
	return err
}

func (c *client) LeaveActor(ctx context.Context, id, who string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	by := api.Acting(ctx)
	actor, exists := actors(s.data)[who]
	if !exists || (by != who && !c.authorizedBy(s.data, ctx, "grant")) {
		return errors.New("actor leave refused")
	}
	next := clone(s.data)
	next.Actors = actors(next)
	delete(next.Actors, who)
	err = s.updateActorsLocked(next, api.Entry{Kind: "actor.left", Actor: by, Data: api.JSON(who)}, c.owner)
	if err == nil {
		s.mu.Unlock()
		c.actorChanged(ctx, "session.leave", id, actor, by)
		s.mu.Lock()
	}
	return err
}

func (c *client) actorChanged(ctx context.Context, point, session string, actor api.Actor, by string) {
	payload := map[string]any{"sessionId": session, "actorId": actor.ID, "actor": actor, "grantedBy": by}
	_, _ = c.h.API().Invoke(ctx, point, payload)
	c.Emit(ctx, api.Event{Kind: point, Session: session, Actor: actor.ID, Data: api.JSON(payload)})
}

// JoinHost serves the authenticated Interface, not any client-supplied actor.
func (c *client) JoinHost(id string, host api.Actor) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.joinHostLocked(host)
}

func recordedHost(s api.Session, id string) bool {
	return slices.ContainsFunc(s.Entries, func(e api.Entry) bool {
		return (e.Kind == "actor.set" && api.Decode[api.Actor](e.Data).ID == id) ||
			(e.Kind == "actor.left" && api.Decode[string](e.Data) == id)
	})
}

func (s *session) joinHostLocked(host api.Actor) error {
	if recordedHost(s.data, host.ID) {
		return nil
	}
	return s.joinActorLocked("", host, "harness")
}
func (c *client) BindChild(ctx context.Context, id, parent, who string) error {
	for ancestor := parent; ancestor != ""; {
		if ancestor == id {
			return errors.New("cyclic parent relationship")
		}
		s, e := c.Snapshot(ancestor)
		if e != nil {
			return e
		}
		ancestor = s.Parent
	}
	ctx = api.AsActor(ctx, who)
	p, err := c.Snapshot(parent)
	if err != nil {
		return err
	}
	if !c.authorizedBy(p, ctx, "delegate") {
		return errors.New("delegation refused")
	}
	var cap []string
	for _, r := range api.Rights {
		if c.authorizedBy(p, ctx, r) {
			cap = append(cap, r)
		}
	}
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Project != p.Project || s.data.Tenant != p.Tenant {
		return api.ErrAuthority
	}
	if s.data.Parent != "" && s.data.Parent != parent {
		return errors.New("different parent")
	}
	next := clone(s.data)
	if next.Parent != "" {
		cap = intersection(cap, next.Ceiling)
	}
	next.Parent, next.ParentActor, next.Depth, next.Ceiling = parent, who, p.Depth+1, cap
	next.Actor = "parent-agent"
	next.Actors = map[string]api.Actor{next.Actor: {ID: next.Actor, Kind: "agent", Rights: cap}}
	next.Settings = p.Settings
	old := s.data
	s.data = next
	_, err = s.recordLocked(api.Entry{Kind: "subagent.bound", Actor: who, Data: api.JSON(api.ActorRef{Session: parent, Actor: who})}, c.owner, true)
	if err != nil {
		s.data = old
	}
	return err
}
func intersection(a, b []string) []string {
	var out []string
	for _, r := range a {
		if slices.Contains(b, r) {
			out = append(out, r)
		}
	}
	return out
}
