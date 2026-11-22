package modular

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServeHistoryLeaseTTL(t *testing.T) {
	const token = "offline-history-lease-fixture"
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		store HistoryStore
		ttl   time.Duration
		want  int64
	}{
		{"default", FileHistory(t.TempDir()), 0, 15000},
		{"explicit", HistoryServiceFiles(t.TempDir()), 2500 * time.Millisecond, 2500},
		{"minimum", MemoryHistory(), time.Millisecond, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, err := ServeHistory(t.Context(), tc.store, HistoryOptions{
				Address: "127.0.0.1:0", TokenFile: tokenFile, LeaseTTL: tc.ttl, AllowVolatileForTests: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := svc.Close(); err != nil {
					t.Error(err)
				}
			})
			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, svc.URL+"/v1", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+token)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("history declaration: %s", res.Status)
			}
			var declaration struct {
				TTLMS int64 `json:"ttlMs"`
			}
			if err := json.NewDecoder(res.Body).Decode(&declaration); err != nil {
				t.Fatal(err)
			}
			if declaration.TTLMS != tc.want {
				t.Fatalf("ttlMs = %d, want %d", declaration.TTLMS, tc.want)
			}
		})
	}
}

func TestServeHistoryRejectsInvalidLeaseTTL(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("offline-history-lease-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, ttl := range []time.Duration{-time.Millisecond, time.Microsecond, 1500 * time.Microsecond} {
		t.Run(ttl.String(), func(t *testing.T) {
			svc, err := ServeHistory(t.Context(), FileHistory(t.TempDir()), HistoryOptions{
				Address: "127.0.0.1:0", TokenFile: tokenFile, LeaseTTL: ttl,
			})
			if svc != nil {
				_ = svc.Close()
				t.Fatal("started a history service with an invalid lease duration")
			}
			var e *Error
			if !errors.As(err, &e) || e.Code != InvalidParams {
				t.Fatalf("want %s, got %v", InvalidParams, err)
			}
		})
	}
}

func TestHTTPHistoryReopens(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("offline-history-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- serveHistory(ctx, HistoryServiceFiles(t.TempDir()), HistoryOptions{TokenFile: tokenFile}, listener)
	}()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	project := t.TempDir()
	p := Provider{ID: "test", Models: func() []ModelInfo {
		return []ModelInfo{{ModelRef: ModelRef{Provider: "test", ID: "offline"}, ContextWindow: 4000, MaxOutput: 2000}}
	}, Request: func(context.Context, ModelRef, ModelRequest, *ProviderContext) (AssistantMessage, error) {
		return AssistantMessage{Content: Text("kept over HTTP"), Stop: "finished"}, nil
	}}
	opts := []Option{WithProject(project), WithDataDir(t.TempDir()), WithDurability(Kept), WithProvider(p), WithHistory(HTTPHistory("http://"+listener.Addr().String(), tokenFile))}
	a, err := New(ctx, opts...)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(context.Background())
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := s.Prompt(ctx, "Keep this.")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	b, err := New(ctx, opts...)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close(context.Background())
	reopened, err := b.OpenSession(ctx, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	last, err := reopened.LastTurn(ctx)
	if err != nil || last == nil || last.Text != "kept over HTTP" || last.TurnID != turn.TurnID {
		t.Fatalf("last: %#v %v", last, err)
	}
}
