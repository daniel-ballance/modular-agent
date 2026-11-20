package acpinterface

import (
	"context"
	"io"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Principal is the operator's policy for an authenticated ACP connection.
// Nil Projects allows any project in the composition. Empty string in Tenants
// allows sessions without a tenant; nil Tenants allows only those sessions.
type Principal struct {
	Actor             api.Actor
	Projects, Tenants []string
}

func (i *Interface) ServePrincipal(ctx context.Context, in io.ReadCloser, out io.Writer, declared func() map[string]any, config Projects, principal Principal) error {
	return i.serve(ctx, in, out, declared, config, principal.Actor.ID, &principal)
}

func (s *server) allowsProject(project string) bool {
	return s.principal == nil || s.principal.Projects == nil || slices.Contains(s.principal.Projects, project)
}
func (s *server) allowsTenant(tenant string) bool {
	return s.principal == nil || (s.principal.Tenants == nil && tenant == "") || slices.Contains(s.principal.Tenants, tenant)
}
func (s *server) hasRight(right string) bool {
	return s.principal == nil || slices.Contains(s.principal.Actor.Rights, right)
}
func (s *server) permitsMembership(sess api.Session) bool {
	if s.principal == nil {
		return true
	}
	if !s.allowsProject(sess.Project) || !s.allowsTenant(sess.Tenant) || !s.hasRight("watch") {
		return false
	}
	// Do not reuse a durable grant broader than the authenticated token.
	if current, ok := sess.Actors[s.actor]; ok {
		for _, right := range current.Rights {
			if !s.hasRight(right) {
				return false
			}
		}
	}
	return true
}
func (s *server) discoverable(sess api.Session) bool {
	if s.principal == nil {
		return true
	}
	if !s.permitsMembership(sess) {
		return false
	}
	return s.a.(interface {
		DiscoverForHost(api.Session, api.Actor) bool
	}).DiscoverForHost(sess, s.hostActor())
}

func (s *server) authorize(id, who, right string) bool {
	if s.principal != nil {
		snap, err := s.a.Snapshot(id)
		if err != nil || !s.permitsMembership(snap) || !s.hasRight(right) {
			return false
		}
	}
	return s.a.Authorize(id, who, right)
}
