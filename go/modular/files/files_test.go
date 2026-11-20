package files_test

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/files"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestFileToolsInBothPlacements(t *testing.T) {
	for _, served := range []bool{false, true} {
		name := "in-process"
		if served {
			name = "process-binding"
		}
		t.Run(name, func(t *testing.T) {
			env := modulartest.MemoryEnvironment(map[string][]byte{"main.txt": []byte("\ufeffone\r\ntwo\r\nthree\r\n"), "image.png": []byte("\x89PNGfixture"), "lines.txt": []byte("a\nb\nc\nd\n")})
			p := files.Plugin(t.TempDir())
			place := modular.WithPlugin(p)
			if served {
				place = modulartest.OverWire(p)
			}
			a := modulartest.Agent(t, place, modular.WithEnvironment(env), modulartest.Script(`[{"toolCalls":[{"name":"edit","input":{"path":"main.txt","edits":[{"oldText":"two\n","newText":"2\n"},{"oldText":"one","newText":"1"}]}},{"name":"read","input":{"path":"lines.txt","offset":2,"limit":2}},{"name":"read","input":{"path":"image.png"}},{"name":"read","input":{"path":"missing"}}]},{"text":"ok"}]`))
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.Prompt(t.Context(), "Test file tools.")
			if err != nil {
				t.Fatal(err)
			}
			rs := r.ToolResults()
			if len(rs) != 4 || rs[0].Text() != "Successfully replaced 2 block(s) in main.txt." || rs[1].Text() != "b\nc\n\n[1 more lines in file. Use offset=4 to continue.]" || len(rs[2].Content) != 2 || rs[2].Content[1].Type != "image" || rs[3].Text() != "File not found: missing" {
				t.Fatal(rs)
			}
			if b, err := env.Read(t.Context(), "/", "main.txt"); err != nil || string(b) != "\ufeff1\r\n2\r\nthree\r\n" {
				t.Fatal(string(b), err)
			}
		})
	}
}

func TestExecTailAndSpill(t *testing.T) {
	env := modulartest.MemoryEnvironment()
	code := 7
	output := "start\n" + strings.Repeat("command output\n", 2000)
	env.OnExec("fixture", func(context.Context, string, func(string)) (modular.ExecResult, error) {
		return modular.ExecResult{ExitCode: &code, Output: output}, nil
	})
	a := modulartest.Agent(t, modular.WithEnvironment(env), modular.WithPlugin(files.Plugin(t.TempDir())), modulartest.Script(`[{"toolCalls":[{"name":"exec","input":{"command":"fixture"}}]},{"text":"ok"}]`))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.Prompt(t.Context(), "Run fixture.")
	if err != nil {
		t.Fatal(err)
	}
	rs := r.ToolResults()
	if len(rs) != 1 || rs[0].Status != modular.Failed || !strings.HasSuffix(rs[0].Text(), "Command exited with code 7") {
		t.Fatal(rs)
	}
	var value struct {
		Truncated bool
		Path      string `json:"full_output_path"`
		ExitCode  int    `json:"exit_code"`
		Output    string
	}
	if err := json.Unmarshal(rs[0].Value, &value); err != nil || !value.Truncated || value.ExitCode != 7 || value.Output != strings.TrimSuffix(strings.TrimPrefix(output, "start\n"), "\n") {
		t.Fatal("unexpected exec result", err, value.Truncated, value.ExitCode)
	}
	b, err := os.ReadFile(value.Path)
	if err != nil || string(b) != output {
		t.Fatal("full output was not preserved", err)
	}
}
