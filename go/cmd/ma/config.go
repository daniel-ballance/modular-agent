package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type layout struct{ config, state, home string }

func directories() (layout, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return layout{}, err
	}
	if p := os.Getenv("MODULAR_AGENT_DATA_DIR"); p != "" {
		p, err = filepath.Abs(p)
		return layout{p, filepath.Join(p, "state"), home}, err
	}
	root := func(name, fallback string) string {
		if p := os.Getenv(name); filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(home, fallback)
	}
	return layout{filepath.Join(root("XDG_CONFIG_HOME", ".config"), "modular-agent"), filepath.Join(root("XDG_STATE_HOME", ".local/state"), "modular-agent", "go"), home}, nil
}
func readJSON(path string, target any) error {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal(b, target); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}
func (d layout) settings(project string) (modular.Settings, error) {
	settings := modular.Settings{"modelTools": []string{"codemode"}, "reasoning": "medium", "maxSteps": 500, "maxOutput": 32000}
	keys := map[string]string{"model": "model", "thinking": "reasoning", "step_limit": "maxSteps", "output_limit": "maxOutput", "model_tools": "modelTools"}
	for _, p := range []string{filepath.Join(d.config, "settings.json"), filepath.Join(project, ".modular-agent.json")} {
		m := map[string]any{}
		if err := readJSON(p, &m); err != nil {
			return nil, err
		}
		for k, v := range m {
			if key, ok := keys[k]; ok {
				settings[key] = v
			}
		}
	}
	return settings, nil
}
func (d layout) trustLedger() string { return filepath.Join(d.config, "trusted-projects.json") }
func (d layout) trust(project string) error {
	ledger := map[string]bool{}
	if err := readJSON(d.trustLedger(), &ledger); err != nil {
		return err
	}
	if ledger == nil {
		ledger = map[string]bool{}
	}
	ledger[project] = true
	if err := os.MkdirAll(d.config, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(d.config, ".trusted-projects-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = writeJSON(f, ledger, true); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), d.trustLedger())
}
func (d layout) trusted(project string) bool {
	var ledger map[string]bool
	return readJSON(d.trustLedger(), &ledger) == nil && ledger[project]
}

var envVar = regexp.MustCompile(`\$\{([^}]+)\}`)

func expandEnv(s string) (string, error) {
	var err error
	out := envVar.ReplaceAllStringFunc(s, func(match string) string {
		name := match[2 : len(match)-1]
		v, ok := os.LookupEnv(name)
		if !ok && err == nil {
			err = fmt.Errorf("environment variable %s is not set", name)
		}
		return v
	})
	return out, err
}
func (d layout) mcp(project string, stderr io.Writer) []modular.MCPServer {
	all := map[string]modular.MCPServer{}
	read := func(path string) {
		var cfg struct {
			Servers map[string]json.RawMessage `json:"mcpServers"`
		}
		if err := readJSON(path, &cfg); err != nil {
			fmt.Fprintln(stderr, err)
			return
		}
		names := sortedKeys(cfg.Servers)
		for _, name := range names {
			s, err := decodeServer(name, cfg.Servers[name])
			if err != nil {
				fmt.Fprintf(stderr, "%s: server %s: %v\n", path, name, err)
			} else if s != nil {
				all[name] = *s
			}
		}
	}
	read(filepath.Join(d.config, "mcp.json"))
	p := filepath.Join(project, ".mcp.json")
	if d.trusted(project) {
		read(p)
	} else if _, e := os.Stat(p); e == nil {
		fmt.Fprintf(stderr, "%s: not used, because this project is not trusted (start once with --trust-project)\n", p)
	}
	var out []modular.MCPServer
	for _, name := range sortedKeys(all) {
		out = append(out, all[name])
	}
	return out
}
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
func decodeServer(name string, raw json.RawMessage) (*modular.MCPServer, error) {
	var s struct {
		modular.MCPServer
		Type     string
		Disabled bool
		Enabled  *bool
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	if s.Disabled || s.Enabled != nil && !*s.Enabled {
		return nil, nil
	}
	s.Name = name
	if s.Type == "" {
		if s.URL != "" {
			s.Type = "http"
		} else {
			s.Type = "stdio"
		}
	}
	var err error
	switch s.Type {
	case "stdio":
		s.URL = ""
		if s.Command == "" {
			return nil, errors.New("command is missing")
		}
		if s.Command, err = expandEnv(s.Command); err != nil {
			return nil, err
		}
		for i, v := range s.Args {
			if s.Args[i], err = expandEnv(v); err != nil {
				return nil, err
			}
		}
	case "http", "streamable-http", "streamableHttp":
		s.Command = ""
		if s.URL == "" {
			return nil, errors.New("url is missing")
		}
		if s.URL, err = expandEnv(s.URL); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("transport %s is not supported; use stdio or http", s.Type)
	}
	for _, fields := range []map[string]string{s.Env, s.Headers} {
		for k, v := range fields {
			if fields[k], err = expandEnv(v); err != nil {
				return nil, err
			}
		}
	}
	return &s.MCPServer, nil
}
func (d layout) history() (modular.HistoryStore, error) {
	if endpoint := os.Getenv("MODULAR_AGENT_HISTORY_URL"); endpoint != "" {
		return modular.HTTPHistory(endpoint, os.Getenv("MODULAR_AGENT_HISTORY_TOKEN_FILE")), nil
	}
	return modular.FileHistory(filepath.Join(d.state, "sessions")), nil
}
func listSessions(ctx context.Context, store modular.HistoryStore, project string) ([]modular.SessionInfo, error) {
	ss, err := store.Sessions(ctx, project)
	if err != nil {
		return nil, err
	}
	sort.Slice(ss, func(i, j int) bool {
		if ss[i].LastActivity.Equal(ss[j].LastActivity) {
			return ss[i].ID < ss[j].ID
		}
		return ss[i].LastActivity.After(ss[j].LastActivity)
	})
	return ss, nil
}
func canonical(p string) (string, error) {
	p, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}
func writeJSON(w io.Writer, data any, pretty bool) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if pretty {
		enc.SetIndent("", "  ")
	}
	return enc.Encode(data)
}
func chosenModel(settings modular.Settings) string {
	switch m := settings["model"].(type) {
	case string:
		return m
	case map[string]any:
		p, _ := m["provider"].(string)
		id, _ := m["id"].(string)
		if p != "" && id != "" {
			return p + "/" + id
		}
	}
	return ""
}
func containsClaude(settings modular.Settings) bool {
	return strings.HasPrefix(chosenModel(settings), "claude/")
}
