package environmenthttp_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/environmenthttp"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSandboxPathsCommandsAndLifetime(t *testing.T) {
	t.Setenv("HOME_SECRET", "private-environment-marker")
	root := t.TempDir()
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "secret"), []byte("outside-secret"), 0600)
	os.Symlink(outside, filepath.Join(root, "escape"))
	s, err := environmenthttp.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s.Handler("token"))
	defer ts.Close()
	c, err := environmenthttp.NewClient(servicehttp.NewClient(ts.URL, "token"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()
	if err = c.Write(ctx, root, "nested/note", []byte("inside")); err != nil {
		t.Fatal(err)
	}
	got, err := c.Read(ctx, root, "nested/note")
	if err != nil || string(got) != "inside" {
		t.Fatal(string(got), err)
	}
	for _, p := range []string{"../outside", filepath.Join(outside, "secret"), "escape/secret"} {
		if _, err = c.Read(ctx, root, p); err == nil {
			t.Fatal("outside read", p)
		}
		if err = c.Write(ctx, root, p, []byte("bad")); err == nil {
			t.Fatal("outside write", p)
		}
	}
	runCtx, cancel := context.WithCancel(ctx)
	live := make(chan string, 10)
	done := make(chan error, 1)
	go func() {
		_, err := c.Bash(runCtx, root, "setsid bash -c 'while :; do echo tick >> cancelled-ticks; sleep .03; done' >/dev/null 2>&1 & printf 'live-output'; sleep 60", func(s string) { live <- s })
		done <- err
	}()
	var progress string
	liveTimer := time.NewTimer(5 * time.Second)
	defer liveTimer.Stop()
	for !strings.Contains(progress, "live-output") {
		select {
		case v := <-live:
			progress += v
		case err := <-done:
			t.Fatalf("command before live output: %s: %v", progress, err)
		case <-liveTimer.C:
			t.Fatal("not live", progress)
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		b, _ := os.ReadFile(filepath.Join(root, "cancelled-ticks"))
		if len(b) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancel fixture did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel hung")
	}
	stoppedWriting(t, filepath.Join(root, "cancelled-ticks"))
	// The shell sees only the sandbox and read-only system binaries, not host files or service environment.
	text, err := c.Bash(ctx, root, "test ! -e '"+filepath.Join(outside, "secret")+"' && test ! -e escape/secret && test -z \"$HOME_SECRET\" && echo isolated", nil)
	if err != nil || !strings.Contains(text, "isolated") {
		t.Fatal(text, err)
	}
	// Background descendants, even setsid, survive shell return but not agent disconnect.
	_, err = c.Bash(ctx, root, "setsid bash -c 'while :; do echo tick >> ticks; sleep .03; done' >/dev/null 2>&1 &", nil)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	before, _ := os.ReadFile(filepath.Join(root, "ticks"))
	if len(before) == 0 {
		t.Fatal("background did not run")
	}
	c.Close()
	stoppedWriting(t, filepath.Join(root, "ticks"))
	if original, _ := os.ReadFile(filepath.Join(outside, "secret")); string(original) != "outside-secret" {
		t.Fatal("outside file changed")
	}
	if _, err = environmenthttp.NewClient(servicehttp.NewClient(ts.URL, "wrong")); err == nil {
		t.Fatal("unauthenticated environment")
	}
}
func stoppedWriting(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		before, _ := os.ReadFile(path)
		time.Sleep(200 * time.Millisecond)
		after, _ := os.ReadFile(path)
		if len(before) > 0 && string(before) == string(after) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("command outlived disconnect", path)
		}
	}
}
