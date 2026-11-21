package modular_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestHTTPErasureRecoversExpiredDestinationAfterLostReply(t *testing.T) {
	ctx := t.Context()
	project, state := t.TempDir(), t.TempDir()
	const token = "history-test-token"
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	svc, err := historyhttp.New(t.TempDir(), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	handler := svc.Handler(token)
	var expired atomic.Pointer[string]
	var dropped atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/pending-erasure") && !dropped.Load() {
			reply := httptest.NewRecorder()
			handler.ServeHTTP(reply, r)
			if reply.Code != http.StatusOK {
				t.Errorf("original publication was refused: %d %s", reply.Code, reply.Body)
			}
			dropped.Store(true)
			panic(http.ErrAbortHandler) // The client never sees the committed reply.
		}
		// The dedicated Go service has no retention setting. Model a peer
		// that hides an expired session but retains its authoritative plans.
		if id := expired.Load(); id != nil {
			path := "/v1/sessions/" + *id
			if r.URL.Path == "/v1/sessions" && r.Method == "GET" {
				reply := httptest.NewRecorder()
				handler.ServeHTTP(reply, r)
				var page historyhttp.ListPage
				if reply.Code != http.StatusOK || json.Unmarshal(reply.Body.Bytes(), &page) != nil || page.Next != "" {
					t.Errorf("unexpected list in retention fixture: %d %s", reply.Code, reply.Body)
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				page.Sessions = slices.DeleteFunc(page.Sessions, func(s historyhttp.Session) bool { return s.ID == *id })
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(page)
				return
			}
			if (r.URL.Path == path || strings.HasPrefix(r.URL.Path, path+"/")) && r.URL.Path != path+"/pending-erasure" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"code":"unknown_session","error":"unknown session"}`))
				return
			}
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	build := func() *modular.Agent {
		t.Helper()
		a, err := modular.New(ctx, modular.WithProject(project), modular.WithDataDir(state), modular.WithDurability(modular.Kept),
			modular.WithHistory(modular.HTTPHistory(server.URL, tokenFile)), modulartest.Script(`[{"text":"answer"}]`))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = a.Close(ctx) })
		return a
	}
	a := build()
	source, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = source.Prompt(ctx, "erase me"); err != nil {
		t.Fatal(err)
	}
	if err := source.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	entries, err := source.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var target string
	for _, entry := range entries {
		if entry["kind"] == "input" {
			target, _ = entry["id"].(string)
			break
		}
	}
	if target == "" {
		t.Fatal("no input to erase")
	}
	fork, err := source.Fork(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.Erase(ctx, []string{target}); err == nil || !dropped.Load() {
		t.Fatalf("erase did not lose its publication reply: %v", err)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	forkID := fork.ID()
	expired.Store(&forkID)
	recovered, err := build().OpenSession(ctx, source.ID())
	if err != nil {
		t.Fatal(err)
	}
	report, err := recovered.Erase(ctx, []string{target})
	if err != nil || !slices.Contains(report.Erased, modular.EntryPair{SessionID: source.ID(), ID: target}) ||
		len(report.Pending) != 0 || !slices.Contains(report.OutOfReach, "copies in other sessions") {
		t.Fatalf("repeated erase: %+v, %v", report, err)
	}
	for _, pair := range report.Erased {
		if pair.SessionID == forkID {
			t.Fatalf("expiry is not confirmed erasure: %+v", report)
		}
	}
}
