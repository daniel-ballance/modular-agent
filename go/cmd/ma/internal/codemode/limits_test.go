package codemode

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/files"
)

func TestNestedWaitIsNotComputation(t *testing.T) {
	l := StandardLimits()
	l.Compute = 50 * time.Millisecond
	defs := []modular.ToolDefinition{files.Tools("")[0].Definition()}
	out, err := testRun(t, "tools.read('fixture').upper()", defs, func(ctx context.Context, _ string, _ any) (modular.ToolResult, error) {
		select {
		case <-ctx.Done():
			return modular.ToolResult{}, ctx.Err()
		case <-time.After(3 * l.Compute):
			return modular.ToolResult{Status: modular.Completed, Content: modular.Text("delayed")}, nil
		}
	}, l)
	if err != nil || out.Status == modular.Failed || out.Content.Text() != "DELAYED" {
		t.Fatalf("nested wait: %+v, %v", out, err)
	}
}

func TestTimeoutCannotBeCaught(t *testing.T) {
	l := StandardLimits()
	l.Compute = 50 * time.Millisecond
	out, err := testRun(t, `
try:
    while True:
        pass
except TimeoutError:
    print('caught the limit')
`, nil, nil, l)
	if err != nil || out.Status != modular.Failed || !strings.Contains(out.Content.Text(), "TimeoutError:") || strings.Contains(out.Content.Text(), "caught the limit") {
		t.Fatalf("compute limit: %+v, %v", out, err)
	}
	assertNextRunWorks(t)
}

func TestRecursionBoundary(t *testing.T) {
	for _, depth := range []int{200, 201} {
		code := fmt.Sprintf("def f(n):\n    if n == 1:\n        return 'bottom'\n    return f(n - 1)\nf(%d)", depth)
		out, err := testRun(t, code, nil, nil, StandardLimits())
		if err != nil {
			t.Fatal(err)
		}
		if depth == 200 && (out.Status == modular.Failed || out.Content.Text() != "bottom") ||
			depth == 201 && (out.Status != modular.Failed || !strings.Contains(out.Content.Text(), "RecursionError:")) {
			t.Fatalf("depth %d: %+v", depth, out)
		}
	}
}

func TestStandardPrintAndResultLimits(t *testing.T) {
	for _, tc := range []struct {
		code, want string
		failed     bool
	}{
		{"print('x' * 1048575)", "1048576 bytes).", false},
		{"print('x' * 1048576)\n'unreachable'", "RuntimeError: printed output exceeded 1048576 bytes", true},
		{"'line\\n' * 2001", "first 2000 of 2001 lines", false},
		{"('a' * 51199) + '\\nb'", "first 1 of 2 lines (51200 of 51201 bytes)", false},
	} {
		out, err := testRun(t, tc.code, nil, nil, StandardLimits())
		if err != nil || (out.Status == modular.Failed) != tc.failed || !strings.Contains(out.Content.Text(), tc.want) {
			text := out.Content.Text()
			t.Errorf("%s: %s … %s (status %s, error %v), want %q", tc.code, utf8Prefix(text, 100), text[max(0, len(text)-140):], out.Status, err, tc.want)
		}
	}
}

func TestPrintLimitKeepsUTF8Prefix(t *testing.T) {
	l := StandardLimits()
	l.PrintBytes = 8
	out, err := testRun(t, "print('abc', end='')\nprint('éé😀')\nprint('unreachable')", nil, nil, l)
	text := out.Content.Text()
	if err != nil || out.Status != modular.Failed || !utf8.ValidString(text) || text != "RuntimeError: printed output exceeded 8 bytes\nabcéé" {
		t.Fatalf("print limit: %q (%s), %v", text, out.Status, err)
	}
}

func TestDeniedAmbientAccess(t *testing.T) {
	for _, code := range []string{
		"import time\ntime.time()",
		"import time\ntime.sleep(0)",
		"import datetime\ndatetime.date.today()",
		"import os\nos.getenv('HOME', 'fallback')",
		"import os\nos.urandom(1)",
		"import random\nrandom.random()",
		"open('fixture.txt')",
		"from pathlib import Path\nPath('/inside').write_text('no')",
		"import socket\nsocket.socket()",
		"import subprocess\nsubprocess.run(['true'])",
	} {
		out, err := testRun(t, code, nil, nil, StandardLimits())
		if err != nil || out.Status != modular.Failed || !strings.Contains(out.Content.Text(), osDenied) {
			t.Errorf("%s: %+v, %v", code, out, err)
		}
	}
	out, err := testRun(t, "import random\na = random.Random(7)\nb = random.Random(7)\n[a.random() for _ in range(3)] == [b.random() for _ in range(3)]", nil, nil, StandardLimits())
	if err != nil || out.Status == modular.Failed || out.Content.Text() != "true" {
		t.Fatalf("seeded generator: %+v, %v", out, err)
	}
	out, err = testRun(t, "import time\ntime.process_time() == time.thread_time() == 0", nil, nil, StandardLimits())
	if err != nil || out.Status == modular.Failed || out.Content.Text() != "true" {
		t.Fatalf("synthetic process clocks: %+v, %v", out, err)
	}
}

func TestNestedStructuredAndUnsuccessfulResults(t *testing.T) {
	var defs []modular.ToolDefinition
	for _, f := range files.Tools("") {
		defs = append(defs, f.Definition())
	}
	out, err := testRun(t, `
assert tools.exec('false')['exit_code'] == 1
try:
    tools.exec('timeout')
except RuntimeError as e:
    assert 'timed out' in str(e)
else:
    assert False
assert tools.read('structured')['a'][0] == 9007199254740993
for name in ['failed', 'refused', 'cancelled']:
    try:
        tools.read(name)
    except RuntimeError as e:
        assert name in str(e)
    else:
        assert False
'outcomes checked'
`, defs, func(_ context.Context, name string, input any) (modular.ToolResult, error) {
		if name == "exec" {
			if string(input.(json.RawMessage)) == `{"command":"timeout"}` {
				return modular.ToolResult{Status: modular.Failed, Value: json.RawMessage(`{"exit_code":null,"timed_out":true}`), Content: modular.Text("timed out")}, nil
			}
			return modular.ToolResult{Status: modular.Failed, Value: json.RawMessage(`{"exit_code":1}`)}, nil
		}
		var a struct{ Path string }
		if err := json.Unmarshal(input.(json.RawMessage), &a); err != nil {
			return modular.ToolResult{}, err
		}
		if a.Path == "structured" {
			return modular.ToolResult{Status: modular.Completed, Value: json.RawMessage(`{"a":[9007199254740993]}`), Content: modular.Content{{Type: "image"}}}, nil
		}
		return modular.ToolResult{Status: modular.ToolStatus(a.Path), Content: modular.Text(a.Path)}, nil
	}, StandardLimits())
	if err != nil || out.Status == modular.Failed || out.Content.Text() != "outcomes checked" {
		t.Fatalf("nested outcomes: %+v, %v", out, err)
	}
}
