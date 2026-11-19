package historyhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/historyhttp"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestClientWaitsForHeldLease(t *testing.T) {
	for _, tc := range []struct {
		name, version string
		staysHeld     bool
		missingHint   bool
	}{
		{"live owner with declared TTL", `{"binding":"modular-agent-history/1","ttlMs":75}`, true, false},
		{"crashed owner with no declared TTL", `{"binding":"modular-agent-history/1"}`, false, false},
		{"supplied service omits retry hint", `{"binding":"modular-agent-history/1","ttlMs":50}`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var attempts []time.Time
			var owner string
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch {
				case r.Method == "GET" && r.URL.Path == "/v1":
					w.Write([]byte(tc.version))
				case r.Method == "POST" && r.URL.Path == "/v1/sessions/s/lease":
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["owner"] == "" {
						t.Error("lease request must have an owner", err)
					}
					if len(attempts) == 0 {
						owner = body["owner"]
					} else if body["owner"] != owner {
						t.Error("lease retry changed owner")
					}
					attempts = append(attempts, time.Now())
					if len(attempts) == 1 || tc.staysHeld {
						w.WriteHeader(http.StatusConflict)
						if tc.missingHint {
							w.Write([]byte(`{"error":"another owner holds the lease","code":"held"}`))
						} else {
							w.Write([]byte(`{"error":"another owner holds the lease","code":"held","retryAfterMs":50}`))
						}
					} else {
						w.Write([]byte(`{"lease":"new","ttlMs":1000}`))
					}
				case r.Method == "DELETE" && r.URL.Path == "/v1/sessions/s/lease/new":
					w.Write([]byte(`{}`))
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL)
					w.WriteHeader(http.StatusBadRequest)
				}
			}))
			defer ts.Close()
			c := historyhttp.NewClient(servicehttp.NewClient(ts.URL, "token"))
			defer c.Close()
			l, err := c.Acquire("s")
			if tc.staysHeld {
				var held *servicehttp.ResponseError
				if !errors.As(err, &held) || held.Code != "held" {
					t.Fatal("expected held within the declared TTL", err)
				}
			} else if err != nil {
				t.Fatal("could not reopen after expiry", err)
			} else if err = l.Close(); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(attempts) < 2 || !tc.staysHeld && len(attempts) != 2 {
				t.Fatal("unexpected attempt count", len(attempts))
			}
			for i := 1; i < len(attempts); i++ {
				if attempts[i].Sub(attempts[i-1]) < 50*time.Millisecond {
					t.Fatal("retried before retryAfterMs", attempts)
				}
			}
			if tc.staysHeld && attempts[len(attempts)-1].Sub(attempts[0]) > 1075*time.Millisecond {
				t.Fatal("retried after the open budget", attempts)
			}
		})
	}
}

func TestReadAndAppendSessionWithNoCheckpoint(t *testing.T) {
	s, err := historyhttp.New(t.TempDir(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s.Handler("token"))
	defer ts.Close()
	w := servicehttp.NewClient(ts.URL, "token")
	call := func(method, path string, in, out any) {
		t.Helper()
		if err := w.CallMethod(context.Background(), method, path, "", in, out); err != nil {
			t.Fatal(method, path, err)
		}
	}
	const p = "/v1/sessions/portable"
	var out any
	call("PUT", p, json.RawMessage(`{"project":"/project","created":1,"parentSessionId":"parent","forkedFrom":{"sessionId":"source","entryId":"fork"}}`), &out)
	var old struct{ Lease string }
	call("POST", p+"/lease", map[string]string{"owner": "other-build"}, &old)
	// This fixture uses the binding directly rather than the Go entry encoder.
	var original []json.RawMessage
	if err := json.Unmarshal([]byte(`[
		{"id":"m","parentId":null,"sessionId":"portable","kind":"setting","time":1000,"writer":"peer","modelVisible":false,"data":{"key":"model","value":{"provider":"conformance","id":"echo"}}},
		{"id":"a","parentId":"m","sessionId":"portable","kind":"actorJoined","time":1001,"writer":"peer","modelVisible":false,"data":{"actor":{"id":"alice","kind":"user","rights":["input"]}}},
		{"id":"i","parentId":"a","sessionId":"portable","kind":"input","time":1002,"writer":"peer","modelVisible":true,"actorId":"alice","turnId":"turn","message":{"role":"user","content":[{"type":"text","text":"kept"}]},"data":{"inputId":"admission","key":"only-once"}},
		{"id":"cache","parentId":"i","sessionId":"portable","kind":"peer.cache","time":1003,"writer":"peer","modelVisible":false,"peerField":9007199254740993},
		{"id":"p","parentId":"cache","sessionId":"portable","kind":"position","time":1004,"writer":"peer","modelVisible":false,"data":{"to":"i"}}
	]`), &original); err != nil {
		t.Fatal(err)
	}
	call("POST", p+"/entries", map[string]any{"lease": old.Lease, "entries": original}, &out)
	call("DELETE", p+"/lease/"+old.Lease, nil, &out)

	c := historyhttp.NewClient(w)
	defer c.Close()
	listed, err := c.List("/project")
	if err != nil || len(listed) != 1 {
		t.Fatal("could not list the portable session", listed, err)
	}
	l, err := c.Acquire("portable")
	if err != nil {
		t.Fatal(err)
	}
	snap, err := l.Load()
	if err != nil || !reflect.DeepEqual(listed[0], snap) {
		t.Fatal("list and load reconstructed different sessions", err)
	}
	if snap.Project != "/project" || snap.Parent != "parent" || snap.ForkedFrom != "source:fork" ||
		snap.Position != "i" || snap.Settings.Model != "conformance/echo" || snap.Actors["alice"].ID != "alice" {
		t.Fatalf("state was not rebuilt from the header and entries: %+v", snap)
	}
	branch := snap.Branch()
	if len(branch) != 3 || branch[2].Content.Text() != "kept" {
		t.Fatal("position did not restore the branch", branch)
	}
	snap.Entries = append(snap.Entries, api.Entry{ID: "new", Parent: snap.Position, Kind: "go.test", Writer: "test", Time: time.UnixMilli(1005)})
	if err := l.Save(snap); err != nil {
		t.Fatal("could not append to the translated session", err)
	}
	var read struct{ Entries []json.RawMessage }
	call("GET", p, nil, &read)
	if len(read.Entries) != len(original)+1 {
		t.Fatal("save must append one entry, not a checkpoint", read.Entries)
	}
	for i, before := range original {
		var compact bytes.Buffer
		if err := json.Compact(&compact, before); err != nil || !bytes.Equal(compact.Bytes(), read.Entries[i]) {
			t.Errorf("original entry %d was changed: %s", i, read.Entries[i])
		}
	}
	newEntry := api.Decode[map[string]any](read.Entries[len(original)])
	if newEntry["id"] != "new" || newEntry["parentId"] != "i" || newEntry["sessionId"] != "portable" || newEntry["time"] != 1005.0 {
		t.Fatal("bad shape on new entry", newEntry)
	}
}
