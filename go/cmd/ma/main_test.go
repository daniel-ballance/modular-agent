package main

import (
	"bytes"
	"encoding/json"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func put(t *testing.T, p, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}
func isolated(t *testing.T) (layout, string, string) {
	t.Helper()
	root := t.TempDir()
	d := layout{filepath.Join(root, "data"), filepath.Join(root, "data", "state"), filepath.Join(root, "home")}
	project := filepath.Join(root, "project")
	log := filepath.Join(root, "requests.jsonl")
	script := filepath.Join(root, "script.json")
	put(t, script, `[{"text":"First."},{"text":"Second."}]`)
	for _, p := range []string{d.config, d.home, project} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", d.home)
	t.Setenv("MODULAR_AGENT_DATA_DIR", d.config)
	t.Setenv("MODULAR_AGENT_SCRIPT", script)
	t.Setenv("MODULAR_AGENT_SCRIPT_LOG", log)
	t.Setenv("MODULAR_AGENT_CONFORMANCE", "")
	t.Setenv("MODULAR_AGENT_HISTORY_URL", "")
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	return d, project, log
}
func TestACPListenOptions(t *testing.T) {
	for _, args := range [][]string{
		{"--listen", "127.0.0.1:0", "--token-file", "token"},
		{"--acp", "--token-file", "token"},
		{"--acp", "--listen=", "--token-file", "token"},
	} {
		if _, err := parse(args); err == nil {
			t.Errorf("accepted %v", args)
		}
	}
	o, err := parse([]string{"--acp", "--listen", "ws://127.0.0.1:0/acp", "--token-file", "token"})
	if err != nil || !o.acp || o.listen != "ws://127.0.0.1:0/acp" || o.tokenFile != "token" {
		t.Fatalf("options = %+v, %v", o, err)
	}
}

func TestInvalidClientIdentityStopsStartup(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MODULAR_AGENT_DATA_DIR", root)
	t.Setenv("MODULAR_AGENT_SCRIPT", filepath.Join(root, "missing-script.json"))
	for _, value := range []string{"", "bad identity!", strings.Repeat("x", 65)} {
		t.Setenv("MA_CLIENT_IDENTITY", value)
		for _, args := range [][]string{{"--help"}, {"-p", "Hello."}} {
			var out bytes.Buffer
			err := run(t.Context(), args, io.NopCloser(strings.NewReader("")), &out, io.Discard, nil)
			if err == nil || !strings.Contains(err.Error(), "MA_CLIENT_IDENTITY") || out.Len() != 0 {
				t.Errorf("MA_CLIENT_IDENTITY=%q, args=%v: got stdout %q and error %v", value, args, out.String(), err)
			}
		}
	}
}

func TestTerminalSessionSurvivesProcessComposition(t *testing.T) {
	d, project, log := isolated(t)
	execute := func(args ...string) string {
		var out, stderr bytes.Buffer
		t.Helper()
		if err := run(t.Context(), append([]string{"--project", project}, args...), io.NopCloser(strings.NewReader("")), &out, &stderr, nil); err != nil {
			t.Fatal(err, stderr.String())
		}
		return out.String()
	}
	if got := execute("--runtime", "transient", "-p", "Start."); got != "First.\n" {
		t.Fatal(got)
	}
	if got := execute("--runtime", "transient", "-c", "-p", "Continue."); got != "Second.\n" {
		t.Fatal(got)
	}
	history := execute("--runtime", "transient", "-c", "--history")
	if !json.Valid([]byte(history)) || !strings.Contains(history, "First.") || !strings.Contains(history, "Second.") {
		t.Fatal(history)
	}
	if _, err := os.Stat(filepath.Join(d.state, "sessions")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatal(string(raw))
	}
	var record struct {
		Tools    []string
		Messages []map[string]any
	}
	if err := json.Unmarshal([]byte(lines[1]), &record); err != nil {
		t.Fatal(err)
	}
	if len(record.Messages) != 3 || record.Messages[1]["text"] != "First." || record.Messages[2]["text"] != "Continue." || len(record.Tools) != 1 || record.Tools[0] != "codemode" {
		t.Fatal(record)
	}
}

func TestPromptWordingAndOrder(t *testing.T) {
	d, project, log := isolated(t)
	put(t, filepath.Join(d.config, "AGENTS.md"), "GLOBAL-FIXTURE\n")
	put(t, filepath.Join(filepath.Dir(project), "CLAUDE.md"), "PARENT-FIXTURE\n")
	put(t, filepath.Join(project, "AGENTS.md"), "PROJECT-FIXTURE\n")
	put(t, filepath.Join(project, "CLAUDE.md"), "SHADOWED-FIXTURE\n")
	put(t, filepath.Join(project, ".agents/skills/harbour/SKILL.md"), "---\nname: harbour\ndescription: Tide <table>\n---\nUse tide tables.\n")
	if err := run(t.Context(), []string{"--project", project, "-p", "/skill:harbour please"}, io.NopCloser(strings.NewReader("")), io.Discard, io.Discard, nil); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		System   string
		Messages []struct{ Text string }
	}
	if err = json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	rustRoot := filepath.Join("..", "..", "..", "rust", "crates")
	source := func(p string) string {
		b, e := os.ReadFile(filepath.Join(rustRoot, p))
		if e != nil {
			t.Fatal(e)
		}
		return string(b)
	}
	extract := func(src, begin, end string) string {
		_, tail, ok := strings.Cut(src, begin)
		if !ok {
			t.Fatal("Rust reference changed", begin)
		}
		v, _, ok := strings.Cut(tail, end)
		if !ok {
			t.Fatal("Rust reference changed", end)
		}
		return v
	}
	rustPrompt := source("standard/src/prompt.rs")
	p := extract(rustPrompt, `const PREAMBLE: &str = "`, `";`)
	rules := extract(rustPrompt, `const RULES: &str = "`, `";`)
	if !strings.HasPrefix(got.System, p+"\n\n"+rules+"\n\n") {
		t.Fatal(got.System)
	}
	listing := strings.ReplaceAll(extract(source("standard/src/skills.rs"), `"The following skills`, `\n\n<available_skills>`), `\n`, "\n")
	intro := "# Functions in codemode" + strings.ReplaceAll(extract(source("tools-code/src/catalog.rs"), `"# Functions in codemode`, `\n",`), `\n`, "\n")
	ordered := []string{"<project_context>", "GLOBAL-FIXTURE", "PARENT-FIXTURE", "PROJECT-FIXTURE", "<skills>", "The following skills" + listing, "Tide &lt;table&gt;", intro, "## tools.read(path: str, limit: float = None, offset: float = None)", "## tools.exec(command: str, timeout: float = None)", "<cwd>\n" + project, "<date>\n" + time.Now().Format("2006-01-02")}
	before := -1
	for _, part := range ordered {
		at := strings.Index(got.System, part)
		if at <= before {
			t.Fatalf("missing/out of order %q\n%s", part, got.System)
		}
		before = at
	}
	if strings.Contains(got.System, "SHADOWED-FIXTURE") || len(got.Messages) != 1 || !strings.Contains(got.Messages[0].Text, "Use tide tables.\n</skill>\n\nplease") {
		t.Fatal(got)
	}
}

func TestSkillsDiscoveryAndTrust(t *testing.T) {
	d, p, _ := isolated(t)
	put(t, filepath.Join(d.config, "skills/tides/SKILL.md"), "---\ndescription: >-\n  Map the harbour\n  and the estuary.\n---\nGlobal.\n")
	put(t, filepath.Join(p, ".agents/skills/tides/SKILL.md"), "---\ndescription: Shadowed\n---\nLocal.\n")
	put(t, filepath.Join(p, ".agents/skills/manual/SKILL.md"), "---\nname: manual\ndescription: Manual skill\ndisable-model-invocation: true\n---\nManual.\n")
	skills, problems := discover(skillFolders(d.config, d.home, p))
	if len(skills) != 2 || len(problems) != 1 || !strings.Contains(problems[0], "already defined") || strings.Contains(skillPrompt(skills), "Manual skill") || !strings.Contains(skillPrompt(skills), "Map the harbour and the estuary.") {
		t.Fatal(skills, problems)
	}
	if expanded, err := expandSkill(skills, "/skill:manual"); err != nil || !strings.Contains(expanded, "Manual.") {
		t.Fatal(expanded, err)
	}
	t.Setenv("MA_MCP_FIXTURE", "http://127.0.0.1:9/mcp")
	put(t, filepath.Join(p, ".mcp.json"), `{"mcpServers":{"x":{"url":"${MA_MCP_FIXTURE}"}}}`)
	var issue bytes.Buffer
	if ss := d.mcp(p, &issue); len(ss) != 0 || !strings.Contains(issue.String(), "not trusted") {
		t.Fatal(ss, issue.String())
	}
	if err := d.trust(p); err != nil {
		t.Fatal(err)
	}
	if ss := d.mcp(p, io.Discard); len(ss) != 1 || ss[0].URL != "http://127.0.0.1:9/mcp" {
		t.Fatal(ss)
	}
}

func TestMaImportsOnlyThePublicSDK(t *testing.T) {
	const module = "github.com/daniel-ballance/modular-agent/go/"
	if err := filepath.WalkDir(".", func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, spec := range f.Imports {
			name, e := strconv.Unquote(spec.Path.Value)
			if e != nil {
				return e
			}
			if strings.HasPrefix(name, module) && name != module+"modular" && !strings.HasPrefix(name, module+"modular/") && !strings.HasPrefix(name, module+"cmd/ma/internal/") {
				t.Errorf("%s imports %s directly", path, name)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
