package agenthttp_test

import (
	"context"
	"encoding/json"
	"github.com/OWNER/modular-agent/go/agenthttp"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"github.com/OWNER/modular-agent/go/vanilla"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPHostKeyedInputReplayAnswersAndCancel(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "q", Name: "ask_user", Input: api.JSON(map[string]any{"question": "pick", "kind": "choice", "options": []string{"blue", "red"}})}}}}}, fake.Script{Response: api.Response{Content: api.Text("blue chosen")}}, fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			<-ctx.Done()
			return api.Response{}, ctx.Err()
		}})
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Model: "fake", Provider: p.Plugin(), Runtime: runtimetest.Plugin(t)})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		linked := filepath.Join(t.TempDir(), "project-link")
		if err = os.Symlink(root, linked); err != nil {
			t.Fatal(err)
		}
		if err = h.Load(agenthttp.Plugin(linked)); err != nil {
			t.Fatal(err)
		}
		v, _ := h.API().Get("interface.http")
		i := v.(*agenthttp.Interface)
		// Lost HTTP input response after the receipt was committed.
		var dropped atomic.Bool
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Idempotency-Key") == "once" && dropped.CompareAndSwap(false, true) {
				rec := httptest.NewRecorder()
				i.Handler("token").ServeHTTP(rec, r)
				c, _, _ := w.(http.Hijacker).Hijack()
				c.Close()
				return
			}
			i.Handler("token").ServeHTTP(w, r)
		}))
		defer ts.Close()
		c := servicehttp.NewClient(ts.URL, "token")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		call := func(q agenthttp.Request) agenthttp.Response {
			t.Helper()
			var out agenthttp.Response
			if err := c.Call(ctx, "/v1/agent", q.Key, q, &out); err != nil {
				t.Fatal(err)
			}
			return out
		}
		id := call(agenthttp.Request{Op: "new"}).Session
		if snap, _ := h.API().Snapshot(id); snap.Project != root {
			t.Fatal("HTTP project was not canonical", snap.Project)
		}
		stream, err := c.Open(ctx, "/v1/agent/events", "", agenthttp.Request{Session: id})
		if err != nil {
			t.Fatal(err)
		}
		d := json.NewDecoder(stream.Body)
		var first agenthttp.Frame
		if err = d.Decode(&first); err != nil {
			t.Fatal(err)
		}
		receipt := call(agenthttp.Request{Op: "input", Session: id, Key: "once", Content: api.Text("ask")}).Receipt
		if !receipt.Duplicate {
			t.Fatal("lost-answer retry not deduplicated")
		}
		var cursor string
		for {
			var f agenthttp.Frame
			if err = d.Decode(&f); err != nil {
				t.Fatal(err)
			}
			if f.Entry != nil {
				cursor = f.Cursor
				if f.Entry.Kind == "question.open" {
					break
				}
			}
		}
		stream.Body.Close()
		questions := call(agenthttp.Request{Op: "questions", Session: id}).Questions
		if len(questions) != 1 || !questions[0].Answerable {
			t.Fatal(questions)
		}
		call(agenthttp.Request{Op: "answer", Session: id, Request: questions[0].ID, Value: "blue"})
		out := call(agenthttp.Request{Op: "wait", Session: id}).Outcome
		if out.Result.Text() != "blue chosen" {
			t.Fatal(out)
		}
		// Reconnect after a question entry. All later recorded entries, including
		// records not emitted as history.added, must be available in order.
		stream, err = c.Open(ctx, "/v1/agent/events", "", agenthttp.Request{Session: id, After: cursor})
		if err != nil {
			t.Fatal(err)
		}
		defer stream.Body.Close()
		d = json.NewDecoder(stream.Body)
		sawAnswer, sawEnd := false, false
		for !sawEnd {
			var f agenthttp.Frame
			if err = d.Decode(&f); err != nil {
				t.Fatal(err)
			}
			if f.Entry != nil {
				if f.Cursor == cursor {
					t.Fatal("cursor replayed")
				}
				sawAnswer = sawAnswer || f.Entry.Kind == "question.answer"
				sawEnd = f.Entry.Kind == "turn.end"
			}
		}
		if !sawAnswer || len(p.Requests()) != 2 {
			t.Fatal("lost replay or duplicate inference")
		}
		call(agenthttp.Request{Op: "input", Session: id, Key: "cancel", Content: api.Text("wait")})
		call(agenthttp.Request{Op: "cancel", Session: id})
		out = call(agenthttp.Request{Op: "wait", Session: id}).Outcome
		if out.Status != "cancelled" {
			t.Fatal(out)
		}
		if _, err := servicehttp.NewClient(ts.URL, "wrong").Open(ctx, "/v1/agent", "", agenthttp.Request{Op: "list"}); err == nil {
			t.Fatal("unauthenticated host")
		}
	})
}
