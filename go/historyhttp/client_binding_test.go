package historyhttp_test

import (
	"encoding/json"
	"modular/api"
	"modular/historyhttp"
	"modular/servicehttp"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// A small independent binding peer, not the Go service, checks client paths,
// millisecond renewals, resend bodies, and permanent loss without reacquisition.
func TestClientAgainstBindingPeer(t *testing.T) {
	var mu sync.Mutex
	var entries []json.RawMessage
	puts, acquires, renews, writes := 0, 0, 0, 0
	lost := false
	var firstBody string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Error("missing auth")
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/sessions/test":
			if puts == 0 {
				w.WriteHeader(404)
				w.Write([]byte(`{"error":"unknown","code":"unknown_session"}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"session": map[string]any{"id": "test", "project": "/p", "created": 1}, "entries": entries})
		case r.Method == "PUT" && r.URL.Path == "/v1/sessions/test":
			puts++
			var p map[string]any
			json.NewDecoder(r.Body).Decode(&p)
			if p["project"] != "/p" || p["created"] == nil || p["id"] != nil {
				t.Error("session shape", p)
			}
			w.Write([]byte(`{}`))
		case r.Method == "POST" && r.URL.Path == "/v1/sessions/test/lease":
			if puts == 0 {
				w.WriteHeader(404)
				w.Write([]byte(`{"error":"unknown","code":"unknown_session"}`))
				return
			}
			acquires++
			var p map[string]any
			json.NewDecoder(r.Body).Decode(&p)
			if p["owner"] == "" {
				t.Error("owner")
			}
			w.Write([]byte(`{"lease":"opaque","ttlMs":120.0}`))
		case r.Method == "POST" && r.URL.Path == "/v1/sessions/test/lease/opaque/renew":
			renews++
			if lost {
				w.WriteHeader(409)
				w.Write([]byte(`{"error":"lost","code":"lost"}`))
				return
			}
			w.Write([]byte(`{"ttlMs":120.0}`))
		case r.Method == "POST" && r.URL.Path == "/v1/sessions/test/entries":
			writes++
			var p struct {
				Lease   string            `json:"lease"`
				Entries []json.RawMessage `json:"entries"`
			}
			json.NewDecoder(r.Body).Decode(&p)
			if p.Lease != "opaque" {
				t.Error("lease")
			}
			if len(p.Entries) != 1 {
				t.Errorf("wanted only the new entry, got: %s", p.Entries)
			} else {
				e := api.Decode[map[string]any](p.Entries[0])
				msg, _ := e["message"].(map[string]any)
				_, hasTime := e["time"].(float64)
				if e["id"] != "entry" || e["sessionId"] != "test" || e["kind"] != "input" ||
					e["parentId"] != nil || e["turnId"] != "turn" || !hasTime || msg["role"] != "user" {
					t.Errorf("entry is not a portable input: %s", p.Entries[0])
				}
			}
			b, _ := json.Marshal(p)
			if writes == 1 {
				firstBody = string(b)
				entries = p.Entries
				c, _, _ := w.(http.Hijacker).Hijack()
				c.Close()
				return
			}
			if firstBody != string(b) {
				t.Error("resend changed body")
			}
			w.Write([]byte(`{"kept":0}`))
		case r.Method == "DELETE" && r.URL.Path == "/v1/sessions/test/lease/opaque":
			w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL)
			w.WriteHeader(400)
			w.Write([]byte(`{}`))
		}
	}))
	defer ts.Close()
	c := historyhttp.NewClient(servicehttp.NewClient(ts.URL, "token"))
	defer c.Close()
	l, err := c.Acquire("test")
	if err != nil {
		t.Fatal(err)
	}
	snap := api.Session{ID: "test", Project: "/p", Version: 1, Entries: []api.Entry{{
		ID: "entry", Kind: "input", Turn: "turn", Time: time.UnixMilli(123), Content: api.Text("kept"), Data: api.JSON("input-id"),
	}}}
	if err = l.Save(snap); err != nil {
		t.Fatal(err)
	}
	got, err := l.Load()
	if err != nil || len(got.Entries) != 1 || got.Entries[0].Content.Text() != "kept" {
		t.Fatal(got, err)
	}
	if err = l.Save(got); err != nil {
		t.Fatal("saving an unchanged translated session", err)
	}
	got.Entries[0].Content = api.Text("changed")
	if err = l.Save(got); err == nil {
		t.Fatal("changed a kept entry")
	}
	deadline := time.Now().Add(time.Second)
	for {
		mu.Lock()
		n := renews
		mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("did not renew within ttl/3")
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	lost = true
	mu.Unlock()
	time.Sleep(100 * time.Millisecond)
	if err = l.Save(snap); err == nil || !strings.Contains(err.Error(), "lost") {
		t.Fatal("lost lease writes", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if acquires != 1 || writes != 2 {
		t.Fatalf("quiet reacquire/write: %d/%d", acquires, writes)
	}
}
