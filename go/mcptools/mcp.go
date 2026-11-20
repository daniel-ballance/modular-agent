// Package mcptools adapts the official MCP Go SDK to the tool-source contract.
// Sources: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
// https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/docs/protocol.md
package mcptools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Server struct {
	Name    string            `json:"name"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}
type connection struct {
	spec     Server
	session  *mcp.ClientSession
	command  *exec.Cmd
	tools    []api.Tool
	routes   map[string]string
	progress map[string]func(string)
	mu       sync.RWMutex
}
type Manager struct {
	a       api.API
	project string
	mu      sync.RWMutex
	groups  map[string][]*connection
	closed  bool
}

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func Name(server, tool string) string { return "mcp_" + server + "__" + tool }

func Plugin(servers []Server, project string) api.Plugin { return Configured(servers, project, nil) }

// Configured starts each configured server independently when warn is set.
func Configured(servers []Server, project string, warn func(error)) api.Plugin {
	m := &Manager{project: project, groups: map[string][]*connection{}}
	return api.Plugin{Name: "mcp", Setup: func(a api.API) error {
		m.a = a
		if err := a.Provide("mcp", m); err != nil {
			return err
		}
		if err := a.Provide("tools.mcp", m); err != nil {
			return err
		}
		for _, hook := range []string{"session.stop", "session.end"} {
			if err := a.Handle(hook, "", func(_ context.Context, v any) (api.Decision, error) {
				m.Remove(v.(string))
				return api.Decision{}, nil
			}); err != nil {
				return err
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if warn == nil {
			return m.Add(ctx, "", servers)
		}
		for _, spec := range servers {
			attempt, done := context.WithTimeout(context.Background(), 15*time.Second)
			err := m.add(attempt, "", []Server{spec}, true)
			done()
			if err != nil {
				warn(fmt.Errorf("server %s: %w", spec.Name, err))
			}
		}
		return nil
	}, Close: m.Close}
}

// Add prepares an entire group before publishing it. A failed connection leaves
// no partial tools or child processes. Client-provided groups are never saved.
func (m *Manager) Add(ctx context.Context, id string, specs []Server) error {
	return m.add(ctx, id, specs, false)
}

// AddConfigured adds one configured server to a session's existing attachment.
func (m *Manager) AddConfigured(ctx context.Context, id string, spec Server) error {
	return m.add(ctx, id, []Server{spec}, true)
}

func (m *Manager) add(ctx context.Context, id string, specs []Server, extend bool) error {
	m.mu.RLock()
	_, exists := m.groups[id]
	closed := m.closed
	m.mu.RUnlock()
	if closed {
		return errors.New("MCP source is closed")
	}
	if exists && !extend {
		return errors.New("MCP group already attached")
	}
	seen := map[string]bool{}
	for _, s := range specs {
		if !namePattern.MatchString(s.Name) || strings.Contains(s.Name, "__") || seen[s.Name] || ((s.Command == "") == (s.URL == "")) {
			return errors.New("invalid or duplicate MCP server")
		}
		seen[s.Name] = true
		if s.URL != "" {
			u, e := url.Parse(s.URL)
			if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
				return errors.New("invalid MCP HTTP URL")
			}
		}
	}
	var group []*connection
	for _, spec := range specs {
		c, err := m.connect(ctx, id, spec)
		if err != nil {
			for _, c := range group {
				c.close()
			}
			return fmt.Errorf("MCP server %s could not connect: %w", spec.Name, err)
		}
		group = append(group, c)
	}
	m.mu.Lock()
	if _, ok := m.groups[id]; (ok && !extend) || m.closed {
		m.mu.Unlock()
		for _, c := range group {
			c.close()
		}
		return errors.New("MCP group already attached")
	}
	// Server names cannot shadow shared servers in the same session.
	if id != "" {
		for _, g := range m.groups[""] {
			if seen[g.spec.Name] {
				m.mu.Unlock()
				for _, c := range group {
					c.close()
				}
				return errors.New("MCP session server shadows a configured server")
			}
		}
	}
	m.groups[id] = append(m.groups[id], group...)
	m.mu.Unlock()
	return nil
}
func (m *Manager) connect(ctx context.Context, id string, spec Server) (*connection, error) {
	c := &connection{spec: spec, routes: map[string]string{}, progress: map[string]func(string){}}
	client := mcp.NewClient(&mcp.Implementation{Name: "modular-agent-go", Version: "0.4"}, &mcp.ClientOptions{
		Capabilities: &mcp.ClientCapabilities{},
		ToolListChangedHandler: func(ctx context.Context, r *mcp.ToolListChangedRequest) {
			if err := c.refresh(ctx, r.Session); err != nil {
				c.mu.Lock()
				c.tools = nil
				c.routes = map[string]string{}
				c.mu.Unlock()
			}
			m.a.Emit(ctx, api.Event{Kind: "tools.changed", Session: id, Data: api.JSON(spec.Name)})
		},
		ProgressNotificationHandler: func(_ context.Context, r *mcp.ProgressNotificationClientRequest) {
			key, _ := r.Params.ProgressToken.(string)
			c.mu.RLock()
			fn := c.progress[key]
			c.mu.RUnlock()
			if fn != nil {
				fn(r.Params.Message)
			}
		},
	})
	var transport mcp.Transport
	if spec.Command != "" {
		cmd := exec.Command(spec.Command, spec.Args...)
		cmd.Dir = m.project
		cmd.Env = os.Environ()
		for k, v := range spec.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		// MCP programs are trusted plugin code, not working-environment commands.
		// The direct child dies with us. Close also terminates its process group.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
		c.command = cmd
		transport = &mcp.CommandTransport{Command: cmd, TerminateDuration: 250 * time.Millisecond}
	} else {
		transport = &mcp.StreamableClientTransport{Endpoint: spec.URL, HTTPClient: &http.Client{Transport: headers{base: http.DefaultTransport, values: spec.Headers}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("MCP redirects refused") }}}
	}
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, err
	}
	c.session = session
	if err = c.refresh(ctx, session); err != nil {
		c.close()
		return nil, err
	}
	return c, nil
}
func (c *connection) refresh(ctx context.Context, session *mcp.ClientSession) error {
	var tools []api.Tool
	routes := map[string]string{}
	for tool, err := range session.Tools(ctx, nil) {
		if err != nil {
			return err
		}
		name := Name(c.spec.Name, tool.Name)
		if !namePattern.MatchString(tool.Name) || len(name) > 64 {
			return errors.New("MCP tool name cannot be represented by this Provider")
		}
		if _, ok := routes[name]; ok {
			return errors.New("duplicate MCP tool name")
		}
		routes[name] = tool.Name
		d := api.Tool{Name: name, Description: tool.Description, Input: api.JSON(tool.InputSchema), Data: api.JSON(tool), Destructive: true, External: true}
		if tool.OutputSchema != nil {
			d.Output = api.JSON(tool.OutputSchema)
		}
		if a := tool.Annotations; a != nil {
			d.ReadOnly = a.ReadOnlyHint
			d.SafeRepeat = a.ReadOnlyHint || a.IdempotentHint
			if a.DestructiveHint != nil {
				d.Destructive = *a.DestructiveHint
			}
			if a.OpenWorldHint != nil {
				d.External = *a.OpenWorldHint
			}
		}
		// MCP has no standard parallel-execution hint. Serial is conservative.
		tools = append(tools, d)
	}
	c.mu.Lock()
	c.tools = tools
	c.routes = routes
	c.mu.Unlock()
	return nil
}
func (m *Manager) connections(id string) []*connection {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := append([]*connection(nil), m.groups[""]...)
	if id != "" {
		out = append(out, m.groups[id]...)
	}
	return out
}
func (m *Manager) Tools(s api.Session) []api.Tool {
	var out []api.Tool
	for _, c := range m.connections(s.ID) {
		c.mu.RLock()
		for _, d := range c.tools {
			d.Input = append(json.RawMessage(nil), d.Input...)
			d.Data = append(json.RawMessage(nil), d.Data...)
			d.Output = append(json.RawMessage(nil), d.Output...)
			out = append(out, d)
		}
		c.mu.RUnlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
func (m *Manager) Run(ctx context.Context, s api.Session, call api.Call, progress func(string)) api.ToolResult {
	result := api.ToolResult{Call: call.ID, Status: "failed"}
	for _, c := range m.connections(s.ID) {
		c.mu.RLock()
		name, ok := c.routes[call.Name]
		c.mu.RUnlock()
		if !ok {
			continue
		}
		var args map[string]any
		if err := json.Unmarshal(call.Input, &args); err != nil || args == nil {
			result.Content = api.Text("MCP arguments must be an object")
			return result
		}
		token := api.ID()
		c.mu.Lock()
		c.progress[token] = progress
		c.mu.Unlock()
		defer func() { c.mu.Lock(); delete(c.progress, token); c.mu.Unlock() }()
		params := &mcp.CallToolParams{Name: name, Arguments: args}
		params.SetProgressToken(token)
		res, err := c.session.CallTool(ctx, params)
		if err != nil {
			result.Status = "unknown"
			if ctx.Err() != nil {
				result.Status = "cancelled"
			}
			result.Content = api.Text("MCP call did not return a reliable result. Check outside effects before relying on it.")
			return result
		}
		result.Status = "completed"
		if res.IsError {
			result.Status = "failed"
		}
		result.Data = api.JSON(res)
		if res.StructuredContent != nil {
			result.Structured = api.JSON(res.StructuredContent)
		}
		for _, part := range res.Content {
			if t, ok := part.(*mcp.TextContent); ok {
				result.Content = append(result.Content, api.Part{Type: "text", Text: t.Text, Data: api.JSON(part)})
			} else {
				result.Content = append(result.Content, api.Part{Type: "mcp", Data: api.JSON(part)})
			}
		}
		if len(result.Content) == 0 && len(result.Structured) > 0 {
			result.Content = api.Text(string(result.Structured))
		}
		return result
	}
	result.Content = api.Text("MCP tool unavailable in this session")
	return result
}
func (c *connection) close() {
	_ = c.session.Close()
	if c.command != nil && c.command.Process != nil {
		_ = syscall.Kill(-c.command.Process.Pid, syscall.SIGKILL)
	}
}
func (m *Manager) Remove(id string) {
	m.mu.Lock()
	group := m.groups[id]
	delete(m.groups, id)
	m.mu.Unlock()
	for _, c := range group {
		c.close()
	}
}
func (m *Manager) Close() error {
	m.mu.Lock()
	all := m.groups
	m.closed = true
	m.groups = map[string][]*connection{}
	m.mu.Unlock()
	for _, g := range all {
		for _, c := range g {
			c.close()
		}
	}
	return nil
}

type headers struct {
	base   http.RoundTripper
	values map[string]string
}

func (h headers) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header = r.Header.Clone()
	for k, v := range h.values {
		if strings.ContainsAny(k+v, "\r\n") {
			return nil, errors.New("invalid MCP header")
		}
		r.Header.Set(k, v)
	}
	return h.base.RoundTrip(r)
}
