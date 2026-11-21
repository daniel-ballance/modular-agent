package modular_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/anthropic"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/openai"
)

func TestProvidersOffline(t *testing.T) {
	cases := []struct {
		name, key, model string
		provider         func(string, *http.Client) modular.Provider
		events           []string
	}{
		{"openai", "OPENAI_API_KEY", "gpt-6-luna", func(url string, client *http.Client) modular.Provider {
			return openai.New(openai.WithEndpoint(url), openai.WithHTTPClient(client))
		}, []string{
			`{"type":"response.output_text.delta","delta":"Hello offline."}`,
			`{"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Hello offline."}]}],"usage":{"input_tokens":8,"output_tokens":2}}}`,
		}},
		{"anthropic", "ANTHROPIC_API_KEY", "claude-haiku-5-5", func(url string, client *http.Client) modular.Provider {
			return anthropic.New(anthropic.WithEndpoint(url), anthropic.WithHTTPClient(client))
		}, []string{
			`{"type":"message_start","message":{"usage":{"input_tokens":8}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello offline."}}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
			`{"type":"message_stop"}`,
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			for _, failure := range []bool{false, true} {
				t.Run(map[bool]string{false: "stream", true: "credentials_refused"}[failure], func(t *testing.T) {
					t.Setenv(test.key, "offline-fixture-value")
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer offline-fixture-value" {
							t.Error("wrong request headers")
						}
						var body struct {
							Model  string
							Stream bool
						}
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Model != test.model || !body.Stream {
							t.Errorf("body: %#v, %v", body, err)
						}
						if failure {
							w.WriteHeader(http.StatusUnauthorized)
							return
						}
						w.Header().Set("Content-Type", "text/event-stream")
						for _, event := range test.events {
							_, _ = fmt.Fprintf(w, "data: %s\n\n", event)
						}
					}))
					defer server.Close()
					a := modulartest.Agent(t, modular.WithProvider(test.provider(server.URL, server.Client())), modular.WithModel(test.name+"/"+test.model))
					session, err := a.Session(t.Context())
					if err != nil {
						t.Fatal(err)
					}
					if failure {
						res, err := session.Prompt(t.Context(), "Say hello.")
						if err != nil || res.Outcome == nil || res.Outcome.Kind != "failed" {
							t.Fatalf("want failed outcome, got %#v, %v", res, err)
						}
						entries, err := session.History(t.Context())
						if err != nil {
							t.Fatal(err)
						}
						found := false
						for _, entry := range entries {
							if entry["kind"] == "response" {
								b, _ := json.Marshal(entry)
								found = strings.Contains(string(b), `"kind":"credentials"`) && strings.Contains(string(b), `"stop":"failed"`) && !strings.Contains(string(b), "offline-fixture-value")
							}
						}
						if !found {
							t.Fatalf("no failed assistant record: %#v", entries)
						}
						return
					}
					var text strings.Builder
					for e, err := range session.PromptStream(t.Context(), "Say hello.") {
						if err != nil {
							t.Fatal(err)
						}
						if p, ok := e.(modular.TextEvent); ok {
							text.WriteString(p.Delta)
						}
					}
					res, err := session.LastTurn(t.Context())
					if err != nil || res == nil || text.String() != "Hello offline." || res.Text != text.String() || res.Usage.Input != 8 || res.Usage.Output != 2 {
						t.Fatalf("text %q, result %#v, error %v", text.String(), res, err)
					}
				})
			}
		})
	}
}
