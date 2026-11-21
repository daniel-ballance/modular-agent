package historyhttp

import (
	"errors"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
)

func TestRegistryOrdersIntentAndAppend(t *testing.T) {
	s, err := New(t.TempDir(), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server := httptest.NewServer(s.Handler("test-token"))
	defer server.Close()
	c := NewClient(servicehttp.NewClient(server.URL, "test-token"))
	defer c.Close()
	if err := c.Verify(); err != nil || !c.ErasureCoordinated() {
		t.Fatalf("verify: %v (coordinator %v)", err, c.ErasureCoordinated())
	}
	l, err := c.AcquireNew("session")
	if err != nil {
		t.Fatal(err)
	}
	next := api.Session{ID: "session", Project: t.TempDir(), Version: 1,
		Entries: []api.Entry{{ID: "one", Kind: "input", Writer: "harness", Time: time.Now().UTC()}}}
	addIntent := func(intents *[]api.ErasureIntent) {
		*intents = append(*intents, api.ErasureIntent{ID: "operation", Source: next.ID, Targets: []string{"one"},
			Copies: []api.ErasureCopy{{EntryPair: api.EntryPair{SessionID: next.ID, ID: "one"}}}})
	}
	// A stale scan cannot miss a copy published before the cutoff.
	err = c.PendingErasures(func(intents *[]api.ErasureIntent) error {
		if err := l.Save(next); err != nil {
			t.Fatal(err)
		}
		addIntent(intents)
		return nil
	})
	if !errors.Is(err, api.ErrErasureUnavailable) {
		t.Fatalf("stale scan: %v", err)
	}
	// A stale writer cannot publish a copy after the cutoff.
	err = c.GuardErasure(func(intents []api.ErasureIntent, guard string) error {
		if len(intents) != 0 {
			t.Fatal("refused intent changed the registry")
		}
		if err := c.PendingErasures(func(i *[]api.ErasureIntent) error { addIntent(i); return nil }); err != nil {
			t.Fatal(err)
		}
		next.Entries = append(next.Entries, api.Entry{ID: "two", Kind: "input", Writer: "harness", Time: time.Now().UTC(), Copies: []string{"one"}})
		return l.(api.GuardedErasureLease).SaveGuarded(next, guard)
	})
	if err == nil {
		t.Fatal("stale writer published a copy")
	}
	if err := os.Remove(s.registryFile()); err != nil {
		t.Fatal(err)
	}
	if err := c.PendingErasures(func(*[]api.ErasureIntent) error { t.Fatal("ran with missing registry"); return nil }); !errors.Is(err, api.ErrErasureUnavailable) {
		t.Fatalf("missing registry: %v", err)
	}
}
