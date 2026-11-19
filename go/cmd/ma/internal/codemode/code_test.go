package codemode

import (
	"context"
	"strings"
	"testing"

	"github.com/OWNER/modular-agent/go/modular"
	"github.com/OWNER/modular-agent/go/modular/files"
)

func TestMontyCallsAndLimits(t *testing.T) {
	var defs []modular.ToolDefinition
	for _, d := range files.Tools("") {
		defs = append(defs, d.Definition())
	}
	fs, err := catalog(defs)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name, code, want string
		fail             bool
		calls            int
	}{
		{"invoke", "print(tools.read(path='in.txt').upper())", "WHITBY", false, 1},
		{"alias", "t = tools\nt.read('in.txt')", "whitby", false, 1},
		{"count", "tools.read('in.txt')\ntools.read('in.txt')", "more than 1 function calls", true, 1},
		{"bad args", "tools.read(other='x')", "unexpected argument other", true, 0},
		{"exception", "tools.read('missing')", "read() failed: file missing", true, 1},
		{"search", "search_tools('bash command')[0]['name']", "exec", false, 0},
		{"describe", "describe_tool(name='list')['signature']", "tools.list(", false, 0},
		{"sandbox", "from pathlib import Path\nPath('in.txt').read_text()", "sandbox has no direct access", true, 0},
		{"syntax", "for", "SyntaxError", true, 0},
		{"recursion", "def f():\n    return f()\nf()", "RecursionError", true, 0},
		{"compute", "while True:\n    pass", "Timeout", true, 0},
		{"print cap", "print('0123456789abcdef')", "0123456789", false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			l := StandardLimits()
			l.Calls = 1
			l.Recursion = 12
			l.PrintBytes = 10
			l.Compute = 50_000_000
			called := 0
			got, err := run(t.Context(), c.code, fs, func(_ context.Context, name string, input any) (modular.ToolResult, error) {
				called++
				if name != "read" {
					t.Fatalf("called %s", name)
				}
				p := input.(map[string]any)["path"]
				if p == "missing" {
					return modular.ToolResult{Status: modular.Failed, Content: modular.Text("file missing")}, nil
				}
				if p != "in.txt" {
					t.Fatalf("unexpected path %v", p)
				}
				return modular.ToolResult{Status: modular.Completed, Content: modular.Text("whitby")}, nil
			}, l)
			if err != nil || (got.Status == modular.Failed) != c.fail || !strings.Contains(got.Content.Text(), c.want) || called != c.calls {
				t.Fatalf("got %+v, %v (calls %d), want %q", got, err, called, c.want)
			}
			if c.name == "print cap" && got.Content.Text() != "0123456789\n" {
				t.Fatal(got.Content.Text())
			}
		})
	}
}
