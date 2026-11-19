package modular

import (
	"context"
	"path/filepath"
	"time"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/mcptools"
	"github.com/OWNER/modular-agent/go/portable"
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
	ID, Project, Model string
	LastActivity       time.Time
}

// Sessions lists saved sessions. An empty project selects every project.
func (s HistoryStore) Sessions(ctx context.Context, project string) ([]SessionInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if s.make == nil {
		return nil, &Error{Code: NotSupported, Message: "history store is not readable"}
	}
	if project != "" {
		p, err := filepath.EvalSymlinks(project)
		if err != nil {
			return nil, err
		}
		project, err = filepath.Abs(p)
		if err != nil {
			return nil, err
		}
	}
	store, err := s.make()
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
	sessions := make([]SessionInfo, 0, len(snaps))
	for _, snap := range snaps {
		info := SessionInfo{ID: snap.ID, Project: snap.Project, Model: snap.Settings.Model}
		for _, e := range snap.Entries {
			if e.Time.After(info.LastActivity) {
				info.LastActivity = e.Time
			}
		}
		sessions = append(sessions, info)
	}
	return sessions, nil
}

// ToolCatalog returns definitions plugins can invoke in the specified session.
// Pass an empty session ID to enumerate globally registered tools.
func (a *Agent) ToolCatalog(sessionID string) ([]ToolDefinition, error) {
	snap := api.Session{Project: a.project}
	if sessionID != "" {
		var err error
		snap, err = a.a.Snapshot(sessionID)
		if err != nil {
			return nil, appError(err, NotOpen)
		}
	}
	out := []ToolDefinition{}
	for _, v := range a.a.All("tools.") {
		for _, d := range v.(api.ToolSource).Tools(snap) {
			if api.CanCall(d, "plugin") {
				var def ToolDefinition
				if err := decodeInto(portable.Tool(d), &def); err != nil {
					return nil, err
				}
				out = append(out, def)
			}
		}
	}
	return out, nil
}

// WithInputTransform expands an input before the built-in command handler runs.
func WithInputTransform(transform func(context.Context, Content) (Content, error)) Option {
	return func(o *options) error { o.input = transform; return nil }
}
