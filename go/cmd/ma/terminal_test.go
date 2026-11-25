package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
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

type secretTerminal struct {
	t           *testing.T
	stderr      *lockedBuffer
	write       *io.PipeWriter
	done        chan error
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
	r, w := io.Pipe()
	term := &secretTerminal{t: t, stderr: &lockedBuffer{}, write: w, done: make(chan error, 1), results: results, credentials: credentials}
	go func() { term.done <- lineMode(t.Context(), s, options{}, input(r), io.Discard, term.stderr, nil) }()
	return term
}

func (s *secretTerminal) typeLine(text string) {
	if _, err := io.WriteString(s.write, text+"\n"); err != nil {
		s.t.Fatal(err)
	}
}

func (s *secretTerminal) waitFor(text string) string {
	s.t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if shown := s.stderr.String(); strings.Contains(shown, text) {
			return shown
		}
	}
	s.t.Fatalf("waiting for %q; shown:\n%s", text, s.stderr.String())
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

func (s *secretTerminal) end() {
	s.t.Helper()
	_ = s.write.Close()
	if err := <-s.done; err != nil {
		s.t.Fatal(err)
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
