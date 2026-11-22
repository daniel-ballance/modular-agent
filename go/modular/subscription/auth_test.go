package subscription_test

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

	"github.com/daniel-ballance/modular-agent/go/modular"
	. "github.com/daniel-ballance/modular-agent/go/modular/subscription"
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
	if err := os.WriteFile(path, []byte(rustAuthFixture), 0600); err != nil {
		t.Fatal(err)
	}
	a := SubscriptionLogins(path)
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

func TestLoginFileRefusesPublicModeAndPreservesOtherMembers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plans.json")
	original := []byte(`{"logins":{},"extension":{"exact":9007199254740993}}`)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	a := SubscriptionLogins(path)
	if _, err := a.Login("chatgpt"); err == nil {
		t.Fatal("read accepted a public login file")
	}
	if err := a.Set(t.Context(), "chatgpt", nil); err == nil {
		t.Fatal("write accepted a public login file")
	}
	if b, err := os.ReadFile(path); err != nil || !bytes.Equal(b, original) {
		t.Fatal("refused write changed the file", err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.Set(t.Context(), "chatgpt", nil); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(path); err != nil || !bytes.Contains(b, []byte(`"exact": 9007199254740993`)) {
		t.Fatal("write did not preserve the other member", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "plans.lock")); err != nil {
		t.Fatal("expected the lock beside the login file", err)
	}
}

func TestStagedAnswerPreservesAuthLogins(t *testing.T) {
	ctx := t.Context()
	a := SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
	if err := a.Set(ctx, "xai", &Login{Type: "api_key", Key: "test-key"}); err != nil {
		t.Fatal(err)
	}
	store := a.CredentialStore()
	receipt, err := store.Stage(ctx, "session", "request", "named", "user", "answer")
	if err != nil {
		t.Fatal(err)
	}
	store = a.CredentialStore() // Re-read the same file, not an in-memory stage.
	got, ok, err := store.LookupStaged(ctx, "session", "request")
	if err != nil || !ok || got != receipt {
		t.Fatalf("stage did not survive: %v", err)
	}
	if value, err := store.Get(ctx, "named"); err != nil || value != "" {
		t.Fatalf("stage visible: %v", err)
	}
	if decision, err := store.Activate(ctx, receipt); err != nil || decision != modular.SecretActivated {
		t.Fatalf("activation: %v, %v", decision, err)
	}
	value, err := store.Get(ctx, "named")
	l, loginErr := a.Login("xai")
	if err != nil || value != "answer" || loginErr != nil || l == nil || l.Secret() != "test-key" {
		t.Fatal("activated answer or login missing", err)
	}
}

func TestRefreshSpendsOneTokenUnderLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "separate.json")
	a := SubscriptionLogins(path)
	second := SubscriptionLogins(path)
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
	run := func(a Logins) {
		defer wg.Done()
		v, err := a.Current(t.Context(), "xai", nil, refresh)
		if err != nil || v.Access != "new" || v.Refresh != "two" {
			t.Errorf("wrong login after refresh: %v, %v", v, err)
		}
	}
	wg.Add(1)
	go run(a)
	<-started
	blocked, cancel := context.WithTimeout(t.Context(), 35*time.Millisecond)
	defer cancel()
	if _, err := second.Current(blocked, "xai", nil, refresh); err != context.DeadlineExceeded {
		t.Errorf("second attempt did not wait for the lock: %v", err)
	}
	wg.Add(1)
	go run(second)
	close(release)
	wg.Wait()
	if count.Load() != 1 {
		t.Fatalf("refreshed %d times", count.Load())
	}
}
