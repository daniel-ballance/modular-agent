package codemode

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/files"
)

func testWorker(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs("../../../../.bin/monty")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("test worker unavailable; run go/scripts/build-monty.sh: %v", err)
	}
	return path
}

func testRun(t *testing.T, code string, defs []modular.ToolDefinition, nested nestedFunc, limits Limits) (modular.ToolOutput, error) {
	t.Helper()
	return runAt(t.Context(), testWorker(t), code, defs, nested, limits)
}

func TestPromptCatalogThreshold(t *testing.T) {
	defs := make([]modular.ToolDefinition, 13)
	for i := range defs {
		defs[i] = modular.ToolDefinition{Name: fmt.Sprintf("fixture_%d", i), Description: strings.Repeat("a", 170) + "\nSecond line", Parameters: []byte(`{"type":"object"}`)}
	}
	full, err := Prompt(defs[:12])
	if err != nil || strings.Count(full, "Second line") != 12 {
		t.Fatalf("full prompt: %v\n%s", err, full)
	}
	short, err := Prompt(defs)
	if err != nil || strings.Count(short, "- `tools.fixture_") != 13 || strings.Contains(short, "Second line") || strings.Contains(short, strings.Repeat("a", 161)) {
		t.Fatalf("abbreviated prompt: %v\n%s", err, short)
	}
}

func TestStandardNestedCallBudget(t *testing.T) {
	defs := []modular.ToolDefinition{files.Tools("")[0].Definition()}
	calls := 0
	result, err := testRun(t, `
for i in range(500):
    search_tools('read')
    describe_tool('read')
    tools.read('fixture.txt', None)
try:
    tools.read('fixture.txt')
except RuntimeError as e:
    print(e)
`, defs, func(context.Context, string, any) (modular.ToolResult, error) {
		calls++
		return modular.ToolResult{Status: modular.Completed, Content: modular.Text("fixture")}, nil
	}, StandardLimits())
	if err != nil || calls != 500 || !strings.Contains(result.Content.Text(), "more than 500 function calls") {
		t.Fatalf("calls=%d, result=%+v, error=%v", calls, result, err)
	}
}

func TestMontyCallsAndLimits(t *testing.T) {
	var defs []modular.ToolDefinition
	for _, d := range files.Tools("") {
		defs = append(defs, d.Definition())
	}
	for _, c := range []struct {
		name, code, want string
		fail             bool
		calls            int
	}{
		{"invoke", "print(tools.read(path='in.txt').upper())", "WHITBY", false, 1},
		{"alias", "t = tools\nt.read('in.txt')", "whitby", false, 1},
		{"import", "before = tools\nimport tools\nfrom tools import read as f\nassert before.read is tools.read\nf(path='in.txt')", "whitby", false, 1},
		{"function value", "f = tools.read\nf('in.txt')", "whitby", false, 1},
		{"bare name", "read('in.txt')", "NameError", true, 0},
		{"positional and None", "tools.read('in.txt', None, None)", "whitby", false, 1},
		{"count", "tools.read('in.txt')\ntools.read('in.txt')", "more than 1 function calls", true, 1},
		{"bad args", "tools.read(other='x')", "unexpected argument other", true, 0},
		{"exception", "tools.read('missing')", "read() failed: file missing", true, 1},
		{"search", "search_tools('bash command')[0]['name']", "exec", false, 0},
		{"describe", "describe_tool(name='list')['signature']", "tools.list(", false, 0},
		{"sandbox", "from pathlib import Path\nPath('in.txt').read_text()", "sandbox has no direct access", true, 0},
		{"syntax", "for", "SyntaxError", true, 0},
		{"recursion", "def f():\n    return f()\nf()", "RecursionError", true, 0},
		{"compute", "while True:\n    pass", "Timeout", true, 0},
		{"print cap", "print('éééééééé')", "ééééé\nRuntimeError: printed output exceeds the 10-byte limit", true, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			l := StandardLimits()
			l.Calls = 1
			l.Recursion = 12
			l.PrintBytes = 10
			if c.name == "compute" {
				l.Compute = 50 * time.Millisecond
			}
			called := 0
			got, err := testRun(t, c.code, defs, func(_ context.Context, name string, input any) (modular.ToolResult, error) {
				called++
				if name != "read" {
					t.Errorf("called %s", name)
				}
				var args map[string]string
				if err := json.Unmarshal(input.(json.RawMessage), &args); err != nil {
					t.Error(err)
				}
				p := args["path"]
				if p == "missing" {
					return modular.ToolResult{Status: modular.Failed, Content: modular.Text("file missing")}, nil
				}
				if p != "in.txt" || len(args) != 1 {
					t.Errorf("unexpected arguments %v", args)
				}
				return modular.ToolResult{Status: modular.Completed, Content: modular.Text("whitby")}, nil
			}, l)
			if err != nil || (got.Status == modular.Failed) != c.fail || !strings.Contains(got.Content.Text(), c.want) || called != c.calls {
				t.Fatalf("got %+v, %v (calls %d), want %q", got, err, called, c.want)
			}
		})
	}
}
