package agenthttp_test

import (
	"context"
	"encoding/json"
	"modular/agenthttp"
	"modular/api"
	"modular/fake"
	"modular/internal/runtimetest"
	"modular/servicehttp"
	"modular/vanilla"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHTTPGateAndApprovalPresence(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		os.WriteFile(filepath.Join(root, "note"), []byte("file-value"), 0600)
		p := fake.New(fake.Script{Chunks: api.Text("hidden-value"), Response: api.Response{Content: api.Text("hidden-value")}})
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Model: "fake", Provider: p.Plugin(), Runtime: runtimetest.Plugin(t), Secrets: []string{"hidden-value"}})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		h.Load(agenthttp.Plugin(root))
		v, _ := h.API().Get("interface.http")
		ts := httptest.NewServer(v.(*agenthttp.Interface).Handler("token"))
		defer ts.Close()
		c := servicehttp.NewClient(ts.URL, "token")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		call := func(q agenthttp.Request) (agenthttp.Response, error) {
			var out agenthttp.Response
			err := c.Call(ctx, "/v1/agent", q.Key, q, &out)
			return out, err
		}
		out, err := call(agenthttp.Request{Op: "new"})
		if err != nil {
			t.Fatal(err)
		}
		id := out.Session
		snap, _ := h.API().Snapshot(id)
		snap.Settings.Approval = "ask-always"
		if _, err = call(agenthttp.Request{Op: "settings", Session: id, Settings: snap.Settings}); err != nil {
			t.Fatal(err)
		}
		out, err = call(agenthttp.Request{Op: "tool", Session: id, Call: api.Call{Name: "read", Input: api.JSON(map[string]string{"path": "note"})}})
		if err != nil || out.ToolResult.Status != "refused" {
			t.Fatal("approval without connected responder did not fail closed", out, err)
		}
		stream, err := c.Open(ctx, "/v1/agent/events", "", agenthttp.Request{Session: id})
		if err != nil {
			t.Fatal(err)
		}
		defer stream.Body.Close()
		d := json.NewDecoder(stream.Body)
		var ready agenthttp.Frame
		d.Decode(&ready)
		done := make(chan agenthttp.Response, 1)
		fail := make(chan error, 1)
		go func() {
			out, err := call(agenthttp.Request{Op: "tool", Session: id, Call: api.Call{Name: "read", Input: api.JSON(map[string]string{"path": "note"})}})
			if err != nil {
				fail <- err
			} else {
				done <- out
			}
		}()
		var request string
		for request == "" {
			var f agenthttp.Frame
			if err = d.Decode(&f); err != nil {
				t.Fatal(err)
			}
			if f.Event != nil && f.Event.Kind == "question.open" {
				request = api.Decode[api.Question](f.Event.Data).ID
			}
		}
		if _, err = call(agenthttp.Request{Op: "answer", Session: id, Request: request, Value: "allow"}); err != nil {
			t.Fatal(err)
		}
		select {
		case out = <-done:
			if out.ToolResult.Status != "completed" || out.ToolResult.Content.Text() != "file-value" {
				t.Fatal(out)
			}
		case err = <-fail:
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		if len(p.Requests()) != 0 {
			t.Fatal("UI call invoked model")
		}
		if _, err = call(agenthttp.Request{Op: "input", Session: id, Content: api.Text("hello")}); err != nil {
			t.Fatal(err)
		}
		out, err = call(agenthttp.Request{Op: "wait", Session: id})
		if err != nil || strings.Contains(string(api.JSON(out)), "hidden-value") {
			t.Fatal("outcome bypassed gate", out, err)
		}
		// Consume the recorded final entry, checking every live and replay item.
		for {
			var f agenthttp.Frame
			if err = d.Decode(&f); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(api.JSON(f)), "hidden-value") {
				t.Fatal("HTTP stream bypassed output gate")
			}
			if f.Entry != nil && f.Entry.Kind == "turn.end" {
				break
			}
		}
		snap, _ = h.API().Snapshot(id)
		if !strings.Contains(string(api.JSON(snap)), "hidden-value") {
			t.Fatal("raw history was redacted")
		}
	})
}
