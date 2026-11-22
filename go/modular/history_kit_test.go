package modular

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

func TestServeHistoryEligibility(t *testing.T) {
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("offline-history-conformance"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, address string
		store         HistoryStore
		code          Code
	}{
		{"volatile", "127.0.0.1:0", MemoryHistory(), NotSupported},
		{"missing", "127.0.0.1:0", HistoryStore{}, NotSupported},
		{"plaintext wildcard", "0.0.0.0:0", FileHistory(t.TempDir()), InvalidParams},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ServeHistory(t.Context(), tc.store, HistoryOptions{Address: tc.address, TokenFile: token})
			var e *Error
			if !errors.As(err, &e) || e.Code != tc.code {
				t.Fatalf("want %s, got %v", tc.code, err)
			}
		})
	}
}

func TestServeHistoryKit(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("history kit requires Node.js")
	}
	kit := filepath.Join("..", "..", "conformance", "history", "run.mjs")
	regex := regexp.MustCompile(`(?m)^40/40 checks passed$`)
	for _, placement := range []string{"memory", "files", "relay"} {
		t.Run(placement, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
			defer cancel()
			token := filepath.Join(t.TempDir(), "token")
			if err := os.WriteFile(token, []byte("offline-history-conformance"), 0600); err != nil {
				t.Fatal(err)
			}
			start := func(store HistoryStore) string {
				l, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				child, stop := context.WithCancel(ctx)
				go func() {
					// The default lease: the kit holds one lease through its
					// multi-megabyte paging section without renewing, and a 3 s
					// lease ran out there on a loaded Mac under -race.
					done <- serveHistory(child, store, HistoryOptions{TokenFile: token, AllowVolatileForTests: placement != "files"}, l)
					_ = l.Close()
				}()
				t.Cleanup(func() {
					stop()
					if err := <-done; err != nil {
						t.Error(err)
					}
				})
				return "http://" + l.Addr().String()
			}
			store := MemoryHistory()
			switch placement {
			case "files":
				store = FileHistory(t.TempDir())
			case "relay":
				store = HTTPHistory(start(store), token)
			}
			url := start(store)
			out, err := exec.CommandContext(ctx, node, kit, url, token).CombinedOutput()
			m := regex.Find(out)
			if err != nil || m == nil {
				t.Fatalf("history kit: %v\n%s", err, out)
			}
			t.Logf("%s", m)
		})
	}
}
