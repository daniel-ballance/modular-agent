package historyhttp_test

import (
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/historyhttp"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestLeasesRetriesAndFencing(t *testing.T) {
	// Give the renewal loop time to run under the race detector and a busy
	// scheduler. The sleep below still crosses the original lease deadline.
	s, err := historyhttp.New(t.TempDir(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Drop each mutation's first answer, after the service performed the work.
	var mu sync.Mutex
	dropped := map[string]bool{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		mu.Lock()
		drop := key != "" && !dropped[key]
		dropped[key] = true
		mu.Unlock()
		if drop {
			rec := httptest.NewRecorder()
			s.Handler("test-token").ServeHTTP(rec, r)
			c, _, _ := w.(http.Hijacker).Hijack()
			c.Close()
			return
		}
		s.Handler("test-token").ServeHTTP(w, r)
	}))
	defer ts.Close()
	a := historyhttp.NewClient(servicehttp.NewClient(ts.URL, "test-token"))
	defer a.Close()
	b := historyhttp.NewClient(servicehttp.NewClient(ts.URL, "test-token"))
	defer b.Close()
	l, err := a.Acquire("session")
	if err != nil {
		t.Fatal(err)
	}
	snap := api.Session{ID: "session", Version: 1, Entries: []api.Entry{{ID: "one", Kind: "test.opaque", Data: []byte(`{"opaqueNumber":9007199254740993}`)}}}
	if err = l.Save(snap); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Acquire("session"); err == nil {
		t.Fatal("second writer admitted")
	}
	got, err := l.Load()
	if err != nil || len(got.Entries) != 1 || string(got.Entries[0].Data) != `{"opaqueNumber":9007199254740993}` {
		t.Fatalf("lost-answer retry/opaque number: %+v %v", got, err)
	}
	time.Sleep(1200 * time.Millisecond) // renewal must keep a live owner exclusive
	if _, err = b.Acquire("session"); err == nil {
		t.Fatal("live lease expired")
	}
	if err = l.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := b.Acquire("session")
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err = l.Save(snap); err == nil {
		t.Fatal("released token still writes")
	}
	// A dead client stops renewing. Its fenced lease can never be revived.
	b.Abort()
	final, err := a.Acquire("session")
	if err != nil {
		t.Fatal(err)
	}
	defer final.Close()
	if err = next.Save(snap); err == nil {
		t.Fatal("expired owner still writes")
	}
	got, err = final.Load()
	if err != nil || len(got.Entries) != 1 {
		t.Fatalf("takeover lost history: %v", err)
	}
	bad := historyhttp.NewClient(servicehttp.NewClient(ts.URL, "wrong"))
	defer bad.Close()
	if _, err = bad.List(""); err == nil {
		t.Fatal("unauthenticated read")
	}
}
