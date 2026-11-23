package modular

import (
	"context"
	"fmt"
	"os"
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
	TokenFile string
	// ClientID is required on an AG-UI listener. TrustTrace opts the token into per-work trace propagation.
	ClientID          string
	TrustTrace        bool
	Actor             Actor
	Tenants, Projects []string
	Represents        []string
}

func validACPActor(actor Actor) bool {
	return actor.ID != "" && utf8.ValidString(actor.ID) && slices.Contains([]string{"user", "host", "agent", "program"}, actor.Kind)
}

func acpPolicy(projects, tenants, rights, represents []string) (acpinterface.Principal, error) {
	p := acpinterface.Principal{Tenants: slices.Clone(tenants), Projects: slices.Clone(projects), Represents: slices.Clone(represents)}
	p.Actor.Rights = slices.Clone(rights)
	bad := func(message string) (acpinterface.Principal, error) {
		return acpinterface.Principal{}, &Error{Code: InvalidComposition, Message: message}
	}
	for _, right := range rights {
		if !slices.Contains(api.Rights, right) {
			return bad("unknown ACP connection right")
		}
	}
	for _, tenant := range tenants {
		if !utf8.ValidString(tenant) {
			return bad("invalid ACP tenant name")
		}
	}
	for _, id := range represents {
		if id == "" || !utf8.ValidString(id) {
			return bad("invalid ACP represented actor ID")
		}
	}
	for i, project := range projects {
		if !utf8.ValidString(project) || !filepath.IsAbs(project) {
			return bad("ACP project scope requires absolute paths")
		}
		canonical, err := configuration.Canonical(project)
		if err != nil {
			return bad("cannot resolve ACP project scope")
		}
		if info, err := os.Stat(canonical); err != nil || !info.IsDir() {
			return bad("ACP project scope requires directories")
		}
		p.Projects[i] = canonical
	}
	return p, nil
}

// LocalACPActor is the operator identity used by stdio ACP when no override is set.
func LocalACPActor() Actor {
	return Actor{ID: "local-user", Kind: "host", Rights: slices.Clone(api.Rights)}
}

// ValidateACPActorTokens verifies the token files and rejects duplicate tokens before serving.
func ValidateACPActorTokens(actors []ACPActor) error {
	seen := map[string]bool{}
	for i, actor := range actors {
		token, err := wswire.ReadToken(actor.TokenFile)
		if err != nil {
			return appError(fmt.Errorf("actors[%d] tokenFile %q: %w", i, actor.TokenFile, err), InvalidComposition)
		}
		if seen[token] {
			return &Error{Code: InvalidComposition, Message: "actors has duplicate bearer tokens"}
		}
		seen[token] = true
	}
	return nil
}

// ListenACP starts serving immediately and returns the listener and its URL.
// ServeACP with the same options blocks until shutdown instead.
func (a *Agent) ListenACP(ctx context.Context, opt ServeACPOptions) (*Service, error) {
	if opt.Listen == "" || opt.Input != nil || opt.Output != nil {
		return nil, &Error{Code: InvalidParams, Message: "ACP service requires Listen and no stdio streams"}
	}
	if opt.Projects != nil || opt.Tenants != nil || opt.Rights != nil || opt.Represents != nil || opt.StdioActor != nil || opt.StdioTrustTrace != nil {
		return nil, &Error{Code: InvalidComposition, Message: "WebSocket scope belongs to each ACP actor"}
	}
	iface, err := a.acpInterface()
	if err != nil {
		return nil, err
	}
	actors := make(map[string]acpinterface.Principal, len(opt.Actors))
	for _, entry := range opt.Actors {
		if !validACPActor(entry.Actor) {
			return nil, &Error{Code: InvalidComposition, Message: "invalid ACP actor identity or kind"}
		}
		policy, err := acpPolicy(entry.Projects, entry.Tenants, append([]string{}, entry.Actor.Rights...), entry.Represents)
		if err != nil {
			return nil, err
		}
		policy.Actor.ID, policy.Actor.Kind = entry.Actor.ID, entry.Actor.Kind
		policy.TrustTrace = entry.TrustTrace
		token, err := wswire.ReadToken(entry.TokenFile)
		if err != nil {
			return nil, appError(err, InvalidParams)
		}
		if _, duplicate := actors[token]; duplicate {
			return nil, &Error{Code: InvalidParams, Message: "duplicate ACP bearer token"}
		}
		actors[token] = policy
	}
	declared, projects := a.acpResources(opt)
	projects = acpinterface.ShareCompositions(projects)
	service, err := wswire.Listen(ctx, opt.Listen, opt.TLS, wswire.ACP, actors, func(ctx context.Context, c *wswire.Conn, p acpinterface.Principal) {
		c.EnableACPControl(opt.ControlDeadline)
		_ = iface.ServePrincipal(ctx, c, c, declared, projects, p)
	})
	return service, appError(err, InvalidParams)
}
