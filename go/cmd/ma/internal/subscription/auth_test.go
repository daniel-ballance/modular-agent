package subscription

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Rust serde_json::to_vec_pretty(Contents), with the variants in
// rust/crates/credentials-auth/src/lib.rs and no trailing newline.
const rustAuthFixture = `{
  "logins": {
    "openai-codex": {
      "type": "oauth",
      "access": "access-codex",
      "refresh": "refresh-codex",
      "expires": 1700000000000,
      "account": "acct-7"
    },
    "xai": {
      "type": "api_key",
      "key": "test-key"
    }
  },
  "answers": {
    "named": "<fixture>&"
  }
}`

func TestRustAuthFixtureRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(rustAuthFixture), 0644); err != nil {
		t.Fatal(err)
	}
	a := AuthFile(path)
	l, err := a.Login("openai-codex")
	if err != nil || l == nil || l.Account == nil || *l.Account != "acct-7" || l.Expires != 1700000000000 {
		t.Fatalf("bad OAuth fixture read: %v, %v", l, err)
	}
	k, err := a.Login("xai")
	if err != nil || k == nil || k.Secret() != "test-key" {
		t.Fatal("API key fixture did not round-trip", err)
	}
	if err := a.Set(t.Context(), "openai-codex", l); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(b, []byte(rustAuthFixture)) {
		t.Fatalf("rewrite differs: %v\n%s", err, b)
	}
	for _, file := range []string{path, filepath.Join(filepath.Dir(path), "auth.lock")} {
		stat, err := os.Stat(file)
		if err != nil || stat.Mode().Perm() != 0600 {
			t.Fatalf("%s mode is not 0600: %v %v", file, stat, err)
		}
	}
}

func TestRefreshSpendsOneTokenUnderLock(t *testing.T) {
	a := AuthFile(filepath.Join(t.TempDir(), "auth.json"))
	old := Login{Type: "oauth", Access: "old", Refresh: "one", Expires: 1}
	if err := a.Set(t.Context(), "xai", &old); err != nil {
		t.Fatal(err)
	}
	var count atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	var wg sync.WaitGroup
	refresh := func(ctx context.Context, l Login) (Login, error) {
		if count.Add(1) != 1 {
			t.Error("spent a refresh twice")
			return Login{}, io.ErrUnexpectedEOF
		}
		if l.Refresh != "one" {
			t.Error("wrong refresh token")
		}
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
			return Login{}, ctx.Err()
		}
		return Login{Type: "oauth", Access: "new", Refresh: "two", Expires: uint64(time.Now().Add(time.Hour).UnixMilli())}, nil
	}
	run := func() {
		defer wg.Done()
		v, err := a.Current(t.Context(), "xai", nil, refresh)
		if err != nil || v.Access != "new" || v.Refresh != "two" {
			t.Errorf("wrong login after refresh: %v, %v", v, err)
		}
	}
	wg.Add(1)
	go run()
	<-started
	blocked, cancel := context.WithTimeout(t.Context(), 35*time.Millisecond)
	defer cancel()
	if _, err := a.Current(blocked, "xai", nil, refresh); err != context.DeadlineExceeded {
		t.Errorf("second attempt did not wait for the lock: %v", err)
	}
	wg.Add(1)
	go run()
	close(release)
	wg.Wait()
	if count.Load() != 1 {
		t.Fatalf("refreshed %d times", count.Load())
	}
}
