package subscription

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

const claudeProgramEnv = "MODULAR_AGENT_CLAUDE_SIDECAR"

// ClaudeOptions selects the TypeScript Claude program. Go starts it with node.
type ClaudeOptions struct{ Program string }

// FindClaudeProgram resolves the explicit path, environment path, or install location.
func FindClaudeProgram(opts ClaudeOptions) (string, error) {
	missing := func() error {
		return &modular.Error{Code: modular.InvalidComposition, Message: "Claude program not found; set ClaudeOptions.Program or " + claudeProgramEnv}
	}
	explicit := opts.Program
	if explicit == "" {
		explicit = os.Getenv(claudeProgramEnv)
	}
	var paths []string
	if explicit != "" {
		paths = []string{explicit}
	} else {
		if exe, err := os.Executable(); err == nil {
			for p, i := filepath.Dir(exe), 0; i < 4; i, p = i+1, filepath.Dir(p) {
				paths = append(paths, filepath.Join(p, "typescript/sidecars/claude/dist/main.js"))
			}
		}
		if home, err := os.UserHomeDir(); err == nil {
			paths = append(paths, filepath.Join(home, ".local/share/modular-agent/sidecars/claude/dist/main.js"))
		}
	}
	for _, path := range paths {
		abs, err := filepath.Abs(path)
		if err == nil {
			if info, err := os.Stat(abs); err == nil && info.Mode().IsRegular() {
				return abs, nil
			}
		}
	}
	return "", missing()
}

// ClaudeProvider owns the Claude process. Close it when finished, or register
// Plugin() to close it when the agent or serving connection stops.
type ClaudeProvider struct {
	process   *pluginrpc.ModelProcess
	state     string
	closeOnce sync.Once
	closeErr  error
	catalogMu sync.Mutex
	catalog   []modular.ModelInfo
}

// Claude starts the Claude program. It does not sign in, read login files or
// forward credentials. The program alone asks Claude Code about its sign-in.
func Claude(ctx context.Context, opts ClaudeOptions) (*ClaudeProvider, error) {
	program, err := FindClaudeProgram(opts)
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, name := range []string{"HOME", "CLAUDE_CONFIG_DIR", "PATH"} {
		if value, ok := os.LookupEnv(name); ok {
			env[name] = value
		}
	}
	dir, err := os.MkdirTemp("", "modular-claude-*")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	child, err := pluginrpc.StartModelProcess(ctx, pluginrpc.Spec{Command: []string{"node", program}, Env: env}, dir, dir, "claude")
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, &modular.Error{Code: modular.InvalidComposition, Message: "could not start the Claude program with Node.js: " + err.Error()}
	}
	c := &ClaudeProvider{process: child, state: dir}
	for _, m := range subscriptionModels("claude") {
		c.catalog = append(c.catalog, m.Info)
	}
	return c, nil
}

// Close stops and reaps the Claude program and removes its temporary state.
func (c *ClaudeProvider) Close() error {
	c.closeOnce.Do(func() { _ = c.process.Close(); c.closeErr = os.RemoveAll(c.state) })
	return c.closeErr
}

// Status reports plan readiness and, when unavailable, why. Only the program
// can check the account; no Go code reads or stores a Claude credential.
func (c *ClaudeProvider) Status(ctx context.Context) (available bool, reason string) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	available, reason, err := c.process.Status(ctx)
	if err != nil {
		return false, "could not check the Claude Code sign-in"
	}
	if available {
		return true, ""
	}
	if reason == "" {
		reason = "Claude Code has no available plan sign-in; run `claude auth login`"
	}
	return false, reason
}

func (c *ClaudeProvider) models() []modular.ModelInfo {
	c.catalogMu.Lock()
	defer c.catalogMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.process.RefreshCatalog(ctx); err == nil {
		if models := c.process.Catalog(); len(models) > 0 {
			c.catalog = make([]modular.ModelInfo, 0, len(models))
			for _, m := range models {
				var info modular.ModelInfo
				_ = json.Unmarshal(api.JSON(portable.Model(m)), &info)
				c.catalog = append(c.catalog, info)
			}
		}
	}
	out := slices.Clone(c.catalog)
	for i := range out {
		out[i].Input, out[i].Thinking = slices.Clone(out[i].Input), slices.Clone(out[i].Thinking)
	}
	return out
}

// Provider returns the SDK Provider backed by this process.
func (c *ClaudeProvider) Provider() modular.Provider {
	return modular.Provider{ID: "claude", Models: c.models, Available: func() bool { available, _ := c.Status(context.Background()); return available }, Request: c.request}
}

// Plugin registers the Provider and takes ownership of the child process.
func (c *ClaudeProvider) Plugin() modular.Plugin {
	return modular.Plugin{Name: "claude", Setup: func(r *modular.Registrar) error { return r.Provider(c.Provider()) }, Stop: c.Close}
}

func (c *ClaudeProvider) request(ctx context.Context, ref modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
	if available, reason := c.Status(ctx); !available {
		return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Credentials, Message: reason}
	}
	session := r.SessionID
	r.SessionID = ""
	if r.Messages == nil {
		r.Messages = []modular.Message{}
	}
	if r.Tools == nil {
		r.Tools = []modular.ToolDefinition{}
	}
	if r.Settings == nil {
		r.Settings = modular.Settings{}
	}
	b, err := json.Marshal(r)
	if err != nil {
		return modular.AssistantMessage{}, err
	}
	raw, err := c.process.Generate(ctx, session, ref.ID, b, func(p api.Part) {
		if len(p.Wire) > 0 {
			var event struct{ ToolCallID string }
			if json.Unmarshal(p.Wire, &event) == nil && event.ToolCallID != "" {
				pc.Piece(p.Type, p.Text, event.ToolCallID)
				return
			}
		}
		pc.Piece(p.Type, p.Text)
	})
	if err != nil {
		if ctx.Err() != nil {
			return modular.AssistantMessage{}, ctx.Err()
		}
		var rpc *pluginrpc.RPCError
		if errors.As(err, &rpc) && rpc.Data.Code == "invalid_request" {
			return modular.AssistantMessage{}, &modular.Error{Code: modular.InvalidRequest, Message: "Claude rejected the request"}
		}
		return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Temporary, Message: "the Claude program could not complete the request"}
	}
	var out modular.AssistantMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		return modular.AssistantMessage{}, err
	}
	return out, nil
}
