package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}
func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type fakeTerminal struct {
	*io.PipeReader
	off, on atomic.Int32
}

func (f *fakeTerminal) echoOff() (func(), error) {
	f.off.Add(1)
	return func() { f.on.Add(1) }, nil
}

type testTerminal struct {
	t      *testing.T
	stderr *lockedBuffer
	write  *io.PipeWriter
	done   chan error
}

func startTestTerminal(t *testing.T, s *modular.Session, input func(*io.PipeReader) io.Reader) *testTerminal {
	t.Helper()
	r, w := io.Pipe()
	t.Cleanup(func() { _ = w.Close(); _ = r.Close() })
	term := &testTerminal{t: t, stderr: &lockedBuffer{}, write: w, done: make(chan error, 1)}
	go func() { term.done <- lineMode(t.Context(), s, options{}, input(r), io.Discard, term.stderr, nil) }()
	return term
}

type secretTerminal struct {
	*testTerminal
	results     chan string
	credentials string
}

func startSecretTerminal(t *testing.T, input func(*io.PipeReader) io.Reader) *secretTerminal {
	dir := t.TempDir()
	results := make(chan string, 1)
	tool := modular.NewTool("ask_secret", "Ask for a key.", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		a, err := tc.Ask(ctx, modular.Question{Kind: "secret", Question: "Deploy key?", Credential: "deploy"})
		result := "stored"
		if a.Declined {
			result = "declined"
		}
		results <- result
		return result, err
	})
	credentials := filepath.Join(dir, "credentials.json")
	a, err := modular.New(t.Context(), modular.WithProject(dir), modular.WithDataDir(filepath.Join(dir, "data")), modular.WithDurability(modular.Kept),
		modular.WithCredentials(modular.FileCredentials(credentials)),
		modular.WithPlugin(modular.Plugin{Name: "secret", Setup: func(r *modular.Registrar) error { return r.Tool(tool) }}),
		modulartest.Script(`[{"toolCalls":[{"name":"ask_secret","input":{}}]},{"text":"Done."}]`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close(context.Background()) })
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return &secretTerminal{startTestTerminal(t, s, input), results, credentials}
}

func (s *testTerminal) typeLine(text string) {
	s.t.Helper()
	if _, err := io.WriteString(s.write, text+"\n"); err != nil {
		s.t.Fatal(err)
	}
}

func (s *testTerminal) waitFor(text string) string {
	s.t.Helper()
	return s.waitForCount(text, 1)
}

func (s *testTerminal) waitForCount(text string, count int) string {
	s.t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if shown := s.stderr.String(); strings.Count(shown, text) >= count {
			return shown
		}
	}
	s.t.Fatalf("waiting for %d occurrences of %q; shown:\n%s", count, text, s.stderr.String())
	return ""
}

func (s *secretTerminal) result() string {
	s.t.Helper()
	select {
	case r := <-s.results:
		return r
	case <-time.After(10 * time.Second):
		s.t.Fatalf("no tool result; shown:\n%s", s.stderr.String())
		return ""
	}
}

func (s *testTerminal) end() {
	s.t.Helper()
	_ = s.write.Close()
	select {
	case err := <-s.done:
		if err != nil {
			s.t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		s.t.Fatalf("terminal did not exit; shown:\n%s", s.stderr.String())
	}
}

func TestTerminalListsCommands(t *testing.T) {
	_, project, log := isolated(t)
	var out, stderr bytes.Buffer
	if err := run(t.Context(), []string{"--project", project}, io.NopCloser(strings.NewReader("/commands\n")), &out, &stderr, nil); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	for _, name := range []string{"/after", "/answer", "/cancel", "/commands", "/compact", "/model", "/skill:NAME", "/skills", "/thinking"} {
		if !slices.Contains(lines, name) {
			t.Errorf("missing %s; stdout: %q; stderr: %q", name, out.String(), stderr.String())
		}
	}
	if !slices.IsSorted(lines) {
		t.Fatalf("commands are not sorted: %q", lines)
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatalf("unexpected model request log: %v", err)
	}
}

const twoToolCalls = `[{"toolCalls":[{"name":"first","input":{}},{"name":"second","input":{}}]},{"text":"Done."}]`

func openTwoTerminalQuestions(t *testing.T) (*testTerminal, <-chan string, [][]string) {
	t.Helper()
	results := make(chan string, 2)
	tool := func(name string) modular.Tool {
		return modular.NewTool(name, "Ask a question.", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
			a, err := tc.Ask(ctx, modular.Question{Kind: "text", Question: name + "?"})
			if a.Declined {
				results <- name + " declined: " + a.Reason
			} else {
				results <- name + "=" + a.Value
			}
			return a.Value, err
		}, modular.Parallel())
	}
	a := modulartest.Agent(t, modulartest.Script(twoToolCalls), modular.WithTool(tool("first")), modular.WithTool(tool("second")))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	term := startTestTerminal(t, s, func(r *io.PipeReader) io.Reader { return r })
	term.typeLine("Ask.")
	term.waitFor("first?\nUse /answer REQUEST_ID VALUE")
	shown := term.waitFor("second?\nUse /answer REQUEST_ID VALUE")
	prompts := regexp.MustCompile(`Question (\S+): (first|second)\?`).FindAllStringSubmatch(shown, -1)
	if len(prompts) != 2 {
		t.Fatalf("want two question IDs; shown:\n%s", shown)
	}
	return term, results, prompts
}

func TestTerminalAnswersOpenQuestionsByID(t *testing.T) {
	term, results, prompts := openTwoTerminalQuestions(t)
	for _, p := range slices.Backward(prompts) {
		term.typeLine("/answer " + p[1] + " value for " + p[2])
		select {
		case got := <-results:
			if want := p[2] + "=value for " + p[2]; got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("no answer for " + p[2])
		}
	}
	term.end()
}

func TestTerminalDeclinesAllOpenQuestionsOnEOF(t *testing.T) {
	term, results, _ := openTwoTerminalQuestions(t)
	term.end()
	var declined []string
	for len(results) > 0 {
		declined = append(declined, <-results)
	}
	slices.Sort(declined)
	if !slices.Equal(declined, []string{"first declined: end of input", "second declined: end of input"}) {
		t.Fatalf("unexpected tool answers: %q", declined)
	}
}

func TestTerminalShowsApprovalsOneAtATime(t *testing.T) {
	ran := make(chan string, 2)
	tool := func(name string) modular.Tool {
		return modular.NewTool(name, "Needs approval.", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
			ran <- name
			return name, nil
		}, modular.Parallel())
	}
	a := modulartest.Agent(t, modulartest.Script(twoToolCalls), modular.WithApproval(modular.All), modular.WithTool(tool("first")), modular.WithTool(tool("second")))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	term := startTestTerminal(t, s, func(r *io.PipeReader) io.Reader { return r })
	term.typeLine("Approve.")
	term.waitFor("Allow? (y/n)")
	term.typeLine("not an answer")
	shown := term.waitFor("Answer y or n.")
	if strings.Count(shown, "Allow? (y/n)") != 1 {
		t.Fatalf("want only one approval prompt; shown:\n%s", shown)
	}
	term.typeLine("y")
	term.waitForCount("Allow? (y/n)", 2)
	term.typeLine("y")
	term.end()
	if shown := term.stderr.String(); strings.Count(shown, "Allow? (y/n)") != 2 {
		t.Fatalf("want two approval prompts; shown:\n%s", shown)
	}
	if len(ran) != 2 {
		t.Fatalf("%d approved tools ran, want 2", len(ran))
	}
}

func TestTerminalDeclinesASecretWithoutATerminal(t *testing.T) {
	term := startSecretTerminal(t, func(r *io.PipeReader) io.Reader { return r })
	term.typeLine("Ask.")
	if got := term.result(); got != "declined" {
		t.Fatal(got)
	}
	term.end()
	if shown := term.stderr.String(); strings.Contains(shown, "Question") {
		t.Fatal(shown)
	}
	if _, err := os.Stat(term.credentials); err == nil {
		raw, _ := os.ReadFile(term.credentials)
		if strings.Contains(string(raw), "deploy") {
			t.Fatal(string(raw))
		}
	}
}

func TestTerminalRefusesAnInlineSecretAndReadsItWithEchoOff(t *testing.T) {
	fake := &fakeTerminal{}
	term := startSecretTerminal(t, func(r *io.PipeReader) io.Reader { fake.PipeReader = r; return fake })
	term.typeLine("Ask.")
	shown := term.waitFor("Use /answer REQUEST_ID (hidden input)")
	id := regexp.MustCompile(`Question (\S+): Deploy key\?`).FindStringSubmatch(shown)[1]
	term.typeLine("/answer " + id + " typed-in-view")
	term.waitFor("Do not put the secret on the command line; use /answer REQUEST_ID")
	if fake.off.Load() != 0 {
		t.Fatal("echo turned off for an inline value")
	}
	term.typeLine("/answer " + id)
	term.waitFor("Secret: ")
	term.typeLine("typed-hidden")
	if got := term.result(); got != "stored" {
		t.Fatal(got)
	}
	term.end()
	if fake.off.Load() != 1 || fake.on.Load() != 1 {
		t.Fatalf("echo off %d times, back on %d times", fake.off.Load(), fake.on.Load())
	}
	raw, err := os.ReadFile(term.credentials)
	if err != nil || !strings.Contains(string(raw), `"deploy":"typed-hidden"`) || strings.Contains(string(raw), "typed-in-view") {
		t.Fatal(string(raw), err)
	}
}

func TestTerminalDeclinesASecretOnRequest(t *testing.T) {
	term := startSecretTerminal(t, func(r *io.PipeReader) io.Reader { return &fakeTerminal{PipeReader: r} })
	term.typeLine("Ask.")
	shown := term.waitFor("Use /answer REQUEST_ID (hidden input)")
	id := regexp.MustCompile(`Question (\S+):`).FindStringSubmatch(shown)[1]
	term.typeLine("/answer " + id + " decline")
	if got := term.result(); got != "declined" {
		t.Fatal(got)
	}
	term.end()
}
