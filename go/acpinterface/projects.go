package acpinterface

import (
	"context"
	"errors"
	"path/filepath"
	"sync"

	acp "github.com/caelis-labs/acp-go-sdk"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/mcptools"
)

// Projects supplies composition and resources for ACP projects.
type Projects struct {
	Compose  func(ctx context.Context, project, sessionID string) (Project, error)
	Settings func(project string, defaults api.Settings) (api.Settings, error)
	MCP      func(project string) ([]mcptools.Server, error)
	WarnMCP  func(error)
}

// Project transfers ownership of one project composition to the connection.
type Project struct {
	API         api.API
	Declaration func() map[string]any
	Close       func() error
}

type projectHosts struct {
	mu       sync.Mutex
	compose  func(context.Context, string, string) (Project, error)
	hosts    map[string]*server
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
	if id != "" {
		if host := s.sessionHost(id); host != s {
			if host.project != project {
				return nil, acpError("forbidden")
			}
			return host, nil
		}
		// A client cannot start another project's composition by pairing its
		// path with a saved ID belonging to a different directory.
		list, err := s.a.List(project)
		if err != nil {
			return nil, err
		}
		found := false
		for _, row := range list {
			if row.ID == id {
				found = true
				break
			}
		}
		if !found {
			return nil, acpError("forbidden")
		}
	}
	h := s.projects
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || s.ctx.Err() != nil {
		return nil, acpError("not_open")
	}
	if host := h.hosts[project]; host != nil {
		return host, nil
	}
	part, err := h.compose(s.ctx, project, id)
	if err != nil {
		return nil, err
	}
	if part.API == nil || part.Close == nil {
		return nil, errors.New("project factory returned no agent")
	}
	host := &server{declared: part.Declaration, a: part.API, project: project, actor: s.actor, ctx: s.ctx,
		peer: s.peer, initialized: true, binding: s.binding, capabilities: s.capabilities,
		represents: s.represents, sessions: map[string]*attachment{}, resources: s.resources}
	unsubscribe := host.subscribe()
	h.hosts[project] = host
	h.cleanups = append(h.cleanups, func() {
		unsubscribe()
		host.stop()
		_ = part.Close()
	})
	return host, nil
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
