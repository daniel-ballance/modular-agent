package anthropic_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/anthropic"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type credentials struct{ reads int }

func (c *credentials) Get(context.Context, string) (string, error) {
	c.reads++
	return "offline-test-token", nil
}
func access(t *testing.T, server *httptest.Server) (api.ModelAccess, *credentials) {
	h := harness.New()
	c := &credentials{}
	if err := h.Load(api.Plugin{Name: "credentials", Setup: func(a api.API) error { return a.Provide("credentials", c) }}); err != nil {
		t.Fatal(err)
	}
	if err := h.Load(anthropic.Plugin(server.URL, server.Client())); err != nil {
		t.Fatal(err)
	}
	v, _ := h.API().Get("provider.anthropic")
	p := v.(api.Provider)
	if _, err := p.Access("another-model"); err == nil {
		t.Fatal("disallowed real model accepted")
	}
	a, err := p.Access("claude-haiku-5-5")
	if err != nil {
		t.Fatal(err)
	}
	if c.reads != 0 {
		t.Fatal("credential fetched before request")
	}
	return a, c
}
func TestMessagesStreamingToolInputUsageAndCredentialBoundary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer offline-test-token" || r.Header.Get("anthropic-version") != "2026-10-21" {
			t.Error("wrong request headers")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "claude-haiku-5-5" || body["stream"] != true || strings.Contains(string(api.JSON(body)), "offline-test-token") {
			t.Error("bad body")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, event := range []string{
			`{"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Reading."}}`,
			`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"read-id","name":"read","input":{}}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"fact.txt\"}"}}`,
			`{"type":"content_block_stop","index":1}`,
			`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}`,
			`{"type":"message_stop"}`,
		} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", event)
		}
	}))
	defer server.Close()
	a, c := access(t, server)
	var chunks []api.Part
	response, err := a.Generate(context.Background(), api.Request{Messages: []api.Message{{Role: "user", Content: api.Text("read")}}, Thinking: "off", MaxOutput: 100}, func(p api.Part) { chunks = append(chunks, p) })
	if err != nil || response.Stop != "tools" || response.Usage.Input != 12 || response.Usage.Cached != 3 || len(response.Content) != 2 || response.Content[1].Call.Name != "read" || len(chunks) == 0 || c.reads != 1 {
		t.Fatal(response, err)
	}
	if string(response.Content[1].Call.Input) != `{"path":"fact.txt"}` {
		t.Fatal(string(response.Content[1].Call.Input))
	}
}
func TestClassifiedFailuresNeverEchoCredentialOrBody(t *testing.T) {
	for _, test := range []struct {
		status     int
		body, kind string
	}{
		{400, `{"error":{"type":"invalid_request_error","message":"prompt is too long; offline-test-token"}}`, "context_too_large"},
		{401, `{"error":{"type":"authentication_error","message":"offline-test-token"}}`, "credentials"},
		{429, `{"error":{"type":"rate_limit_error","message":"offline-test-token"}}`, "temporary"},
	} {
		t.Run(test.kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(test.status)
				_, _ = fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			a, _ := access(t, server)
			_, err := a.Generate(context.Background(), api.Request{Thinking: "off", MaxOutput: 20}, func(api.Part) {})
			e, ok := err.(*api.ModelError)
			if !ok || e.Kind != test.kind || strings.Contains(e.Error(), "offline-test-token") {
				t.Fatal(err)
			}
		})
	}
}
func TestIncompleteStreamIsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "data: {\"type\":\"message_start\",\"message\":{}}\n\n")
	}))
	defer server.Close()
	a, _ := access(t, server)
	if _, err := a.Generate(context.Background(), api.Request{Thinking: "off", MaxOutput: 20}, func(api.Part) {}); err == nil {
		t.Fatal("incomplete stream completed")
	}
}
