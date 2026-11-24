package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// The command uses the SDK listener. These reads are snapshot options, not
// capability declarations, and do not need an extra ma flag or an ACP socket.
func TestMAOffersHostReadsOnlyOnThreadSnapshot(t *testing.T) {
	d, project, _ := isolated(t)
	const token = "disposable-ma-host-read-token"
	file := filepath.Join(d.config, "test-token")
	put(t, file, token)
	ctx, stop := context.WithCancel(t.Context())
	out, w := net.Pipe()
	done := make(chan error, 1)
	go func() {
		err := run(ctx, []string{"--agui", "--listen", "127.0.0.1:0", "--token-file", file, "--project", project}, w, w, io.Discard, nil)
		_ = w.Close()
		done <- err
	}()
	t.Cleanup(func() {
		stop()
		out.Close()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	origin, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	base := strings.TrimSpace(origin) + "/agui/v1"
	request := func(method, path, body string, want int) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, base+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Body.Close() })
		if r.StatusCode != want {
			t.Fatalf("%s %s: HTTP %d, want %d", method, path, r.StatusCode, want)
		}
		return r
	}
	var created struct {
		ThreadID    string
		Declaration map[string]any
	}
	if err := json.NewDecoder(request("POST", "/threads", "{}", 201).Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"waitCursor", "runReceipts"} {
		if _, ok := created.Declaration[key]; ok {
			t.Fatalf("unexpected declaration key %s", key)
		}
	}
	thread := "/threads/" + created.ThreadID
	var snap struct {
		WaitCursor  string
		RunReceipts int
	}
	if err := json.NewDecoder(request("GET", thread, "", 200).Body).Decode(&snap); err != nil || snap.WaitCursor == "" || snap.RunReceipts != 1 {
		t.Fatal("missing snapshot reads", err)
	}
	feed := request("GET", thread+"/wait-closures?after="+snap.WaitCursor, "", 200)
	if feed.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal("not a feed")
	}
	feed.Body.Close()
	path := thread + "/run-receipt?runId=first"
	request("GET", path, "", 404)
	run := request("POST", "/run", fmt.Sprintf(`{"threadId":%q,"runId":"first","protocolVersion":"1.0","messages":[{"id":"q","role":"user","content":"Say hello."}]}`, created.ThreadID), 200)
	if _, err := io.Copy(io.Discard, run.Body); err != nil {
		t.Fatal(err)
	}
	var receipt map[string]string
	if err := json.NewDecoder(request("GET", path, "", 200).Body).Decode(&receipt); err != nil || len(receipt) != 2 || receipt["terminal"] != "success" || receipt["work"] != "completed" {
		t.Fatal(receipt, err)
	}
}
