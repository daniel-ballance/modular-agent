package acpinterface

import (
	"context"
	"errors"
	"path/filepath"
	"sync"

	acp "github.com/caelis-labs/acp-go-sdk"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/mcptools"
)

// Projects supplies composition and resources for ACP projects.
type Projects struct {
	// RetainWriter reports sessions also held by another Interface on this listener.
	RetainWriter func(string) bool
	Compose      func(ctx context.Context, project, sessionID string) (Project, error)
	Settings     func(project string, defaults api.Settings) (api.Settings, error)
	MCP          func(project string) ([]mcptools.Server, error)
	WarnMCP      func(error)
	pool         *projectPool
}

// ShareCompositions gives one listener a project pool. Each connection still
// owns its ACP attachment, actor, representation and routing state.
func ShareCompositions(config Projects) Projects {
	if config.Compose != nil {
		config.pool = &projectPool{parts: map[projectKey]*sharedProject{}}
	}
	return config
}

type sharedProject struct {
	part        Project
	connections connectionAttachments
	refs        int
}

type projectPool struct {
	mu    sync.Mutex
	parts map[projectKey]*sharedProject
}

func (p *projectPool) acquire(ctx context.Context, key projectKey, id string, compose func(context.Context, string, string) (Project, error)) (Project, *connectionAttachments, func(), error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var selected *sharedProject
	var selectedKey projectKey
	if id != "" {
		selected, selectedKey = p.writer(key.project, id)
	}
	if selected == nil {
		selected, selectedKey = p.parts[key], key
	}
	if selected == nil && key.savedModel != "" {
		local := projectKey{project: key.project}
		if part := p.parts[local]; part != nil && offersModel(part.part.API, key.savedModel) {
			selected, selectedKey = part, local
		}
	}
	if selected == nil {
		part, err := compose(context.WithoutCancel(ctx), key.project, id)
		if err != nil {
			return Project{}, nil, nil, err
		}
		if part.API == nil || part.Close == nil {
			return Project{}, nil, nil, errors.New("project factory returned no agent")
		}
		selected = &sharedProject{part: part}
		p.parts[key] = selected
	}
	selected.refs++
	return selected.part, &selected.connections, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		selected.refs--
		if selected.refs == 0 {
			delete(p.parts, selectedKey)
			_ = selected.part.Close()
		}
	}, nil
}

// writer finds an existing composition without taking a lease or opening
// a project merely to inspect it. The caller holds the pool lock.
func (p *projectPool) writer(project, id string) (*sharedProject, projectKey) {
	for k, part := range p.parts {
		if k.project == project && hasWriter(part.part.API, id) {
			return part, k
		}
	}
	return nil, projectKey{}
}

func hasWriter(a api.API, id string) bool {
	w, ok := a.(interface {
		SessionInterruption(string) (<-chan struct{}, <-chan struct{}, error)
	})
	if !ok {
		return false
	}
	_, _, err := w.SessionInterruption(id)
	return err == nil
}

func (s *server) listingAPI(row api.Session) api.API {
	if p := s.resources.pool; p != nil {
		p.mu.Lock()
		defer p.mu.Unlock()
		if part, _ := p.writer(row.Project, row.ID); part != nil {
			return part.part.API
		}
	} else if h := s.projects; h != nil {
		h.mu.Lock()
		defer h.mu.Unlock()
		for k, host := range h.hosts {
			if k.project == row.Project && hasWriter(host.a, row.ID) {
				return host.a
			}
		}
	}
	return s.a
}

// Project transfers ownership of one project composition to the connection.
type Project struct {
	API         api.API
	Declaration func() map[string]any
	Close       func() error
}

type projectKey struct{ project, savedModel string }

type projectHosts struct {
	mu       sync.Mutex
	compose  func(context.Context, string, string) (Project, error)
	hosts    map[projectKey]*server
	cleanups []func()
	closed   bool
}

func (s *server) projectHost(cwd, id string, extra []string, prompt *acp.SystemPrompt) (*server, error) {
	if s.projects == nil {
		return s, nil
	}
	if err := s.ready(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(cwd) || len(extra) != 0 || prompt != nil {
		return nil, acp.NewInvalidParams(map[string]string{"reason": "absolute cwd required; additional directories and client system prompts unsupported"})
	}
	project, err := configuration.Canonical(cwd)
	if err != nil {
		return nil, acp.NewInvalidParams(map[string]string{"reason": err.Error()})
	}
	if !s.allowsProject(project) {
		return nil, acpError("forbidden")
	}
	key := projectKey{project: project}
	if id != "" {
		if host := s.sessionHost(id); host != s {
			if host.project != project {
				return nil, acpError("forbidden")
			}
			return host, nil
		}
		// Authorize the stored scope before passing the ID to the factory.
		list, err := s.a.List("")
		if err != nil {
			return nil, err
		}
		found := false
		for _, row := range list {
			if row.ID == id && s.discoverable(row) {
				if row.Project != project {
					return nil, acpError("wrong_project")
				}
				found = true
				key.savedModel = row.Settings.Model
				break
			}
		}
		if !found {
			return nil, acpError("forbidden")
		}
		if s.project == project && s.resources.RetainWriter != nil && s.resources.RetainWriter(id) {
			// The operator already opened this writer at startup.
			return s, nil
		}
	}
	h := s.projects
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || s.ctx.Err() != nil {
		return nil, acpError("not_open")
	}
	if host := h.hosts[key]; host != nil {
		return host, nil
	}
	if key.savedModel != "" {
		if host := h.hosts[projectKey{project: project}]; host != nil && host.offers(key.savedModel) {
			return host, nil
		}
	}
	var part Project
	var shared *connectionAttachments
	var release func()
	if p := s.resources.pool; p != nil {
		part, shared, release, err = p.acquire(s.ctx, key, id, h.compose)
	} else {
		part, err = h.compose(s.ctx, project, id)
	}
	if err != nil {
		return nil, err
	}
	if part.API == nil || part.Close == nil {
		return nil, errors.New("project factory returned no agent")
	}
	if release == nil {
		release = func() { _ = part.Close() }
	}
	host := &server{declared: part.Declaration, a: part.API, project: project, actor: s.actor, principal: s.principal, ctx: s.ctx, shared: shared,
		peer: s.peer, initialized: true, binding: s.binding, capabilities: s.capabilities,
		represents: s.represents, sessions: map[string]*attachment{}, resources: s.resources}
	unsubscribe := host.subscribe()
	h.hosts[key] = host
	h.cleanups = append(h.cleanups, func() {
		unsubscribe()
		host.stop()
		release()
	})
	return host, nil
}

func (s *server) offers(model string) bool { return offersModel(s.a, model) }

func offersModel(a api.API, model string) bool {
	for _, p := range a.All("provider.") {
		for _, m := range p.(api.Provider).Catalog() {
			if modelMatches(m, model) {
				return true
			}
		}
	}
	return false
}

func (s *server) sessionHost(id string) *server {
	if s.projects != nil {
		s.projects.mu.Lock()
		defer s.projects.mu.Unlock()
		for _, host := range s.projects.hosts {
			if _, err := host.attached(id); err == nil {
				return host
			}
		}
	}
	return s
}

func (s *server) addProjectMCP(ctx context.Context, id string) error {
	if s.resources.MCP == nil {
		return nil
	}
	// Use the selected project composition, not the listener's configuration.
	// Legacy callers without a trust source supply only already-trusted MCP.
	if c, err := s.a.Get("configuration"); err == nil {
		if trust, ok := c.(interface{ Trusted(string) (bool, error) }); ok {
			allowed, err := trust.Trusted(s.project)
			if err != nil || !allowed {
				return err
			}
		}
	}
	specs, err := s.resources.MCP(s.project)
	if err != nil {
		return err
	}
	for _, spec := range specs {
		// Startup failures in configured project servers leave other servers usable.
		if err := s.mcp().AddConfigured(ctx, id, spec); err != nil && s.resources.WarnMCP != nil {
			s.resources.WarnMCP(err)
		}
	}
	return nil
}
