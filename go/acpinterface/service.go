package acpinterface

import (
	"context"
	"io"
	"slices"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Connections sharing the same harness reuse its writer. The shared
// lifecycle lock also protects refs; only the last disconnect unloads it.
type connectionAttachments struct {
	mu   sync.Mutex
	refs map[string]int
}

func (s *server) sessionLifecycle() *sync.Mutex {
	if s.shared != nil {
		return &s.shared.mu
	}
	return &s.lifecycle
}

func (s *server) link(id string) {
	if s.shared != nil {
		if s.shared.refs == nil {
			s.shared.refs = map[string]int{}
		}
		s.shared.refs[id]++
	}
}

func (s *server) unlink(id string) bool {
	if s.shared == nil {
		return true
	}
	s.shared.refs[id]--
	if s.shared.refs[id] > 0 {
		return false
	}
	delete(s.shared.refs, id)
	return s.resources.RetainWriter == nil || !s.resources.RetainWriter(id)
}

// Principal is the operator's policy for an authenticated ACP connection.
// Nil Projects allows any project in the composition. Empty string in Tenants
// allows sessions without a tenant; nil Tenants allows only those sessions.
type Principal struct {
	// TrustTrace allows per-request trace context from this authenticated client.
	TrustTrace        bool
	Actor             api.Actor
	Projects, Tenants []string
	Represents        []string
	joinOnOpen        bool
}

func (i *Interface) ServePrincipal(ctx context.Context, in io.ReadCloser, out io.Writer, declared func() map[string]any, config Projects, principal Principal) error {
	return i.serve(ctx, in, out, declared, config, principal.Actor.ID, &principal)
}

func (s *server) allowsProject(project string) bool {
	return s.principal == nil || s.principal.Projects == nil || slices.Contains(s.principal.Projects, project)
}
func (s *server) allowsTenant(tenant string) bool {
	return s.principal == nil && tenant == "" || s.principal != nil && ((s.principal.Tenants == nil && tenant == "") || slices.Contains(s.principal.Tenants, tenant))
}
func (s *server) hasRight(right string) bool {
	return s.principal == nil || s.principal.Actor.Rights == nil || slices.Contains(s.principal.Actor.Rights, right)
}
func (s *server) permitsMembership(sess api.Session) bool {
	return (s.projects != nil || sess.Project == s.project) && s.allowsProject(sess.Project) && s.allowsTenant(sess.Tenant)
}
func (s *server) intersectRecorded(sess api.Session) []string {
	token := s.principal.Actor.Rights
	if recorded, ok := sess.Actors[s.actor]; ok {
		return *api.IntersectConnectionRights(&token, &recorded.Rights)
	}
	return token
}

func (s *server) discoverable(sess api.Session) bool {
	if !s.permitsMembership(sess) || !s.hasRight("watch") {
		return false
	}
	return s.a.(interface {
		DiscoverForHost(api.Session, api.Actor, bool) bool
	}).DiscoverForHost(sess, s.hostActor(), s.principal.joinOnOpen)
}

func (s *server) acting(ctx context.Context, id, who string) context.Context {
	ctx = api.WithSessionScope(api.AsActor(ctx, who), func(project, tenant string) bool {
		return (s.projects != nil || project == s.project) && s.allowsProject(project) && s.allowsTenant(tenant)
	})
	if s.principal != nil && s.principal.Actor.Rights != nil {
		rights := s.principal.Actor.Rights
		if value, ok := s.connectionRights.Load(id); ok {
			rights = value.([]string)
		}
		ctx = api.WithConnectionRights(ctx, &rights)
	}
	return ctx
}

func (s *server) authorize(id, who, right string) bool {
	snap, err := s.a.Snapshot(id)
	return err == nil && s.permitsMembership(snap) && api.ConnectionAllows(s.acting(s.ctx, id, who), right) && s.a.Authorize(id, who, right)
}

func (s *server) erasureEpoch(id string) (int, error) {
	if a, ok := s.a.(interface{ ErasureEpoch(string) (int, error) }); ok {
		return a.ErasureEpoch(id)
	}
	return 0, nil
}

func (s *server) canDeliver(st *attachment, id, who string) bool {
	s.mu.Lock()
	live := !s.closed && st != nil && s.sessions[id] == st && st.ctx.Err() == nil &&
		(who == st.actor || st.joined[who] != nil)
	s.mu.Unlock()
	return live && s.authorize(id, st.actor, "watch") && s.authorize(id, who, "watch")
}
