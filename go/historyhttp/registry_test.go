package historyhttp

import (
	"context"
	"encoding/json"
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
	defer l.Close()
	next := api.Session{ID: "session", Project: t.TempDir(), Version: 1,
		Entries: []api.Entry{{ID: "one", Kind: "input", Writer: "harness", Time: time.Now().UTC()}}}
	if err := l.Save(next); err != nil {
		t.Fatal(err)
	}
	_, before, err := c.ErasurePlans(next.ID)
	if err != nil {
		t.Fatal(err)
	}
	next.Entries = append(next.Entries, api.Entry{ID: "two", Kind: "summary", Writer: "harness", Time: time.Now().UTC(), Copies: []string{"one"}})
	if err := l.Save(next); err != nil {
		t.Fatal(err)
	}
	intent := api.ErasureIntent{ID: "operation", Source: next.ID, Targets: []string{"one"},
		Copies: []api.ErasureCopy{{EntryPair: api.EntryPair{SessionID: next.ID, ID: "one"}}, {EntryPair: api.EntryPair{SessionID: next.ID, ID: "two"}}}}
	writer := l.(api.RemoteErasureLease)
	assertCode := func(err error, code string) {
		t.Helper()
		var refusal *servicehttp.ResponseError
		if !errors.As(err, &refusal) || refusal.Code != code {
			t.Fatalf("want %s, got %v", code, err)
		}
	}
	_, err = writer.PublishErasure(before, intent)
	assertCode(err, "stale_revision")
	plans, fresh, err := c.ErasurePlans(next.ID)
	if err != nil || len(plans) != 0 {
		t.Fatalf("stale publication changed plans: %v, %v", plans, err)
	}
	id, err := writer.PublishErasure(fresh, intent)
	if err != nil || id != intent.ID {
		t.Fatalf("publish: %s, %v", id, err)
	}
	entries := []json.RawMessage{json.RawMessage(`{"id":"three","parentId":null,"sources":["one"]}`)}
	err = c.profileCall(context.Background(), "POST", path(next.ID)+"/entries", appendBody(l.(*lease).token, entries), nil, fresh)
	assertCode(err, "stale_revision")
	next.Entries = append(next.Entries, api.Entry{ID: "three", Kind: "summary", Writer: "harness", Time: time.Now().UTC(), Copies: []string{"one"}})
	if err := l.Save(next); !errors.Is(err, api.ErrErasureUnavailable) {
		t.Fatalf("pending source: %v", err)
	}
	if err := os.Remove(s.registryFile()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.ErasurePlans(next.ID); !errors.Is(err, api.ErrErasureUnavailable) {
		t.Fatalf("missing registry: %v", err)
	}
}
