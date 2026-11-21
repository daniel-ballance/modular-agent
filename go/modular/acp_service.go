package modular

import (
	"context"
	"path/filepath"
	"slices"
	"unicode/utf8"

	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
)

// ACPActor binds a private token file to one connection principal.
// Nil Projects allows any project supported by this composition. Nil Tenants
// permits only untenantized sessions. Include "" to allow those in a list.
type ACPActor struct {
	TokenFile         string
	Actor             Actor
	Tenants, Projects []string
}

// LocalACPActor is the operator identity used by stdio ACP when no override is set.
func LocalACPActor() Actor {
	return Actor{ID: "local-user", Kind: "host", Rights: slices.Clone(api.Rights)}
}

// ListenACP starts serving immediately and returns the listener and its URL.
// ServeACP with the same options blocks until shutdown instead.
func (a *Agent) ListenACP(ctx context.Context, opt ServeACPOptions) (*Service, error) {
	if opt.Listen == "" || opt.Input != nil || opt.Output != nil {
		return nil, &Error{Code: InvalidParams, Message: "ACP service requires Listen and no stdio streams"}
	}
	iface, err := a.acpInterface()
	if err != nil {
		return nil, err
	}
	actors := make(map[string]acpinterface.Principal, len(opt.Actors))
	for _, entry := range opt.Actors {
		id := entry.Actor.ID
		if id == "" || !utf8.ValidString(id) || !slices.Contains([]string{"user", "host", "agent", "program"}, entry.Actor.Kind) {
			return nil, &Error{Code: InvalidParams, Message: "invalid ACP actor identity or kind"}
		}
		rights := append([]string{}, entry.Actor.Rights...)
		for _, r := range rights {
			if !slices.Contains(api.Rights, r) {
				return nil, &Error{Code: InvalidParams, Message: "unknown ACP actor right"}
			}
		}
		entry.Actor.Rights = rights
		var scope []string
		if entry.Projects != nil {
			scope = []string{}
		}
		for _, project := range entry.Projects {
			if !filepath.IsAbs(project) {
				return nil, &Error{Code: InvalidParams, Message: "ACP project scope requires absolute paths"}
			}
			p, err := configuration.Canonical(project)
			if err != nil {
				return nil, appError(err, InvalidParams)
			}
			scope = append(scope, p)
		}
		token, err := wswire.ReadToken(entry.TokenFile)
		if err != nil {
			return nil, appError(err, InvalidParams)
		}
		if _, duplicate := actors[token]; duplicate {
			return nil, &Error{Code: InvalidParams, Message: "duplicate ACP bearer token"}
		}
		actors[token] = acpinterface.Principal{Actor: entry.Actor, Tenants: slices.Clone(entry.Tenants), Projects: scope}
	}
	declared, projects := a.acpResources(opt)
	service, err := wswire.Listen(ctx, opt.Listen, opt.TLS, wswire.ACP, actors, func(ctx context.Context, c *wswire.Conn, p acpinterface.Principal) {
		c.EnableACPControl(opt.ControlDeadline)
		_ = iface.ServePrincipal(ctx, c, c, declared, projects, p)
	})
	return service, appError(err, InvalidParams)
}
