package local_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/local"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestFilesFollowProject(t *testing.T) {
	env := local.New()
	defer env.Close()
	a, b := t.TempDir(), t.TempDir()
	ctx := context.Background()
	if err := env.Write(ctx, a, "nested/file", []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := env.Write(ctx, b, "nested/file", []byte("second")); err != nil {
		t.Fatal(err)
	}
	got, err := env.Read(ctx, a, "nested/file")
	if err != nil || string(got) != "first" {
		t.Fatal(string(got), err)
	}
	if _, err = os.Stat(filepath.Join(b, "nested/file")); err != nil {
		t.Fatal(err)
	}
}
func TestBashStreamsBeforeExit(t *testing.T) {
	env := local.New()
	defer env.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	progress := make(chan string, 4)
	done := make(chan error, 1)
	go func() {
		_, err := env.Bash(ctx, t.TempDir(), "printf ready; sleep 1; printf done", func(s string) { progress <- s })
		done <- err
	}()
	select {
	case s := <-progress:
		if !strings.Contains(s, "ready") {
			t.Fatal(s)
		}
	case <-ctx.Done():
		t.Fatal("no live output")
	}
	select {
	case err := <-done:
		t.Fatalf("command exited before delayed output: %v", err)
	default:
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestShortCommandStreamsAllOutputBeforeReturning(t *testing.T) {
	t.Setenv("GOMAXPROCS", "1")
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(1))
	env := local.NewAt(t.TempDir())
	defer env.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	project := t.TempDir()
	for i := 0; i < 40; i++ {
		var streamed strings.Builder
		result, err := env.Exec(ctx, project, "printf short", 0, func(chunk string) { streamed.WriteString(chunk) })
		if err != nil || result.Output != "short" || streamed.String() != "short" {
			t.Fatalf("command %d: result=%q streamed=%q err=%v", i, result.Output, streamed.String(), err)
		}
	}
}

func TestBackgroundShellReturnsAndCancellationStopsForeground(t *testing.T) {
	env := local.New()
	defer env.Close()
	start := time.Now()
	out, err := env.Bash(context.Background(), t.TempDir(), "sleep 60 & printf started", func(string) {})
	if err != nil || out != "started" || time.Since(start) > 2*time.Second {
		t.Fatal(out, err, time.Since(start))
	}
	ctx, cancel := context.WithCancel(context.Background())
	progress := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		_, err := env.Bash(ctx, t.TempDir(), "printf running; exec sleep 60", func(string) { progress <- struct{}{} })
		done <- err
	}()
	<-progress
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel had no error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel left foreground running")
	}
}
