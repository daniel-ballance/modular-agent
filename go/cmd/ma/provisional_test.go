package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

func TestACPNewLeavesNoPersistentSession(t *testing.T) {
	for _, store := range []string{"file", "http"} {
		t.Run(store, func(t *testing.T) {
			d, project, _ := isolated(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var url string
			const token = "offline-ma-acp-history-128bit"
			if store == "http" {
				file := filepath.Join(d.config, "history-token")
				put(t, file, token)
				svc, err := modular.ListenHistory(ctx, modular.HistoryServiceFiles(filepath.Join(d.state, "remote")), modular.HistoryOptions{Address: "127.0.0.1:0", TokenFile: file})
				if err != nil {
					t.Fatal(err)
				}
				defer svc.Close()
				url = svc.URL
				t.Setenv("MODULAR_AGENT_HISTORY_URL", url)
				t.Setenv("MODULAR_AGENT_HISTORY_TOKEN_FILE", file)
			}
			server, peer := net.Pipe()
			deadline, _ := ctx.Deadline()
			if err := peer.SetDeadline(deadline); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				defer server.Close()
				done <- run(ctx, []string{"--acp", "--project", project}, server, server, io.Discard, nil)
			}()
			defer func() {
				_ = peer.Close()
				if err := <-done; err != nil {
					t.Error(err)
				}
			}()
			decoder := json.NewDecoder(peer)
			call := func(id int, method string, params map[string]any) map[string]any {
				t.Helper()
				if err := json.NewEncoder(peer).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
					t.Fatalf("send %s: %v", method, err)
				}
				for {
					var reply struct {
						ID     int
						Error  json.RawMessage
						Result map[string]any
					}
					if err := decoder.Decode(&reply); err != nil {
						t.Fatalf("receive %s: %v", method, err)
					}
					if reply.ID == id {
						if reply.Error != nil {
							t.Fatalf("%s: %s", method, reply.Error)
						}
						return reply.Result
					}
				}
			}
			call(1, "initialize", map[string]any{"protocolVersion": 1})
			result := call(2, "session/new", map[string]any{"cwd": project, "mcpServers": []any{}})
			id, ok := result["sessionId"].(string)
			if !ok || id == "" {
				t.Fatalf("no session id: %v", result)
			}
			assertUnpublished := func() {
				t.Helper()
				if store == "file" {
					rows, err := os.ReadDir(filepath.Join(d.state, "sessions"))
					if err != nil && !errors.Is(err, os.ErrNotExist) {
						t.Fatal(err)
					}
					for _, row := range rows {
						if name := row.Name(); name != ".pending-erasure" && name != ".pending-erasure.lock" {
							t.Errorf("session/new left %s in persistent history", name)
						}
					}
					return
				}
				// A GET by ID also detects an early PUT of unlisted metadata.
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/v1/sessions/"+id, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+token)
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				var body struct{ Code string }
				if err := json.NewDecoder(res.Body).Decode(&body); err != nil || res.StatusCode != http.StatusNotFound || body.Code != "unknown_session" {
					t.Errorf("session/new touched HTTP history: %s, %+v, %v", res.Status, body, err)
				}
			}
			assertUnpublished()
			call(3, "session/close", map[string]any{"sessionId": id})
			assertUnpublished()
		})
	}
}
