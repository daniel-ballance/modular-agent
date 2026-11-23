package modular

import (
	"context"
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/mcptools"
)

// MCPServer describes a trusted stdio or Streamable HTTP server.
type MCPServer = mcptools.Server

// WithMCP configures the SDK's MCP tool source. A non-nil warn callback
// receives failed server starts; other servers stay available.
func WithMCP(servers []MCPServer, warn func(error)) Option {
	return func(o *options) error { o.mcp = append(o.mcp, servers...); o.mcpWarning = warn; return nil }
}

// WithConformanceFixtures loads the ACP kit's fixtures. Use only with isolated test state.
func WithConformanceFixtures() Option {
	return func(o *options) error { o.conformance = true; return nil }
}

// SessionInfo identifies a stored session without opening or recovering it.
type SessionInfo struct {
	ID, Project, Model, Title, Tenant string
	UnfinishedTurn                    bool // committed start without an end; a writer may still hold it
	Settings                          Settings
	CreatedAt, LastActivity           time.Time
}

// Sessions lists saved sessions. An empty project selects every project.
func (s HistoryStore) Sessions(ctx context.Context, project string) ([]SessionInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if s.make == nil {
		return nil, &Error{Code: NotSupported, Message: "history store is not readable"}
	}
	return storedSessions(s.make, project)
}

// SessionInfo returns stored metadata without leasing or recovering the session.
func (s HistoryStore) SessionInfo(ctx context.Context, id string) (SessionInfo, error) {
	rows, err := s.Sessions(ctx, "")
	return findSessionInfo(rows, id, err)
}

// Sessions lists stored sessions without opening them. An empty project selects all.
func (a *Agent) Sessions(ctx context.Context, project ...string) ([]SessionInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if len(project) > 1 {
		return nil, &Error{Code: InvalidParams, Message: "at most one project filter"}
	}
	filter := ""
	if len(project) == 1 {
		var err error
		filter, err = canonicalSessionProject(project[0])
		if err != nil {
			return nil, err
		}
	}
	rows, err := a.a.List(filter)
	return sessionInfos(rows), appError(err, Internal)
}

// SessionInfo returns one stored session without opening it.
func (a *Agent) SessionInfo(ctx context.Context, id string) (SessionInfo, error) {
	rows, err := a.Sessions(ctx)
	return findSessionInfo(rows, id, err)
}

func findSessionInfo(rows []SessionInfo, id string, err error) (SessionInfo, error) {
	if err != nil {
		return SessionInfo{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return SessionInfo{}, &Error{Code: NotFound, Message: "session not found"}
}

func canonicalSessionProject(project string) (string, error) {
	if project != "" {
		p, err := filepath.EvalSymlinks(project)
		if err != nil {
			return "", appError(err, InvalidParams)
		}
		project, err = filepath.Abs(p)
		if err != nil {
			return "", appError(err, InvalidParams)
		}
	}
	return project, nil
}

func storedSessions(open func() (api.Store, error), project string) ([]SessionInfo, error) {
	project, err := canonicalSessionProject(project)
	if err != nil {
		return nil, err
	}
	store, err := open()
	if err != nil {
		return nil, appError(err, Internal)
	}
	if c, ok := store.(interface{ Close() error }); ok {
		defer c.Close()
	}
	snaps, err := store.List(project)
	if err != nil {
		return nil, appError(err, Internal)
	}
	return sessionInfos(snaps), nil
}

func sessionInfos(snaps []api.Session) []SessionInfo {
	sessions := make([]SessionInfo, 0, len(snaps))
	for _, snap := range snaps {
		info := SessionInfo{ID: snap.ID, Project: snap.Project, Tenant: snap.Tenant, UnfinishedTurn: snap.UnfinishedTurn() != nil, Model: snap.Settings.Model, Settings: sessionSettings(snap.Settings)}
		var meta struct{ Title string }
		_ = json.Unmarshal(snap.HistoryMeta, &meta)
		info.Title = meta.Title
		for _, e := range snap.Entries {
			if info.CreatedAt.IsZero() || e.Time.Before(info.CreatedAt) {
				info.CreatedAt = e.Time
			}
			if e.Time.After(info.LastActivity) {
				info.LastActivity = e.Time
			}
		}
		sessions = append(sessions, info)
	}
	return sessions
}

// WithInputTransform expands an input before the built-in command handler runs.
func WithInputTransform(transform func(context.Context, Content) (Content, error)) Option {
	return func(o *options) error { o.input = transform; return nil }
}
