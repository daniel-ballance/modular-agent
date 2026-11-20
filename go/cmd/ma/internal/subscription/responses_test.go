package subscription

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestResponsesRequestsAndRefresh(t *testing.T) {
	for _, v := range []Vendor{Codex, Xai} {
		t.Run(string(v), func(t *testing.T) {
			var requests, refreshes atomic.Int32
			access := "new-access"
			if v == Codex {
				access = jwt()
			}
			httpFixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/token":
					refreshes.Add(1)
					_ = r.ParseForm()
					want := codexClient
					if v == Xai {
						want = xaiClient
					}
					if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("client_id") != want || r.Form.Get("refresh_token") != "refresh-one" {
						t.Error("wrong refresh form")
					}
					b := map[string]any{"access_token": access, "expires_in": 3600}
					if v == Codex {
						b["refresh_token"] = "refresh-two"
					}
					_ = json.NewEncoder(w).Encode(b)
				case "/responses":
					n := requests.Add(1)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body["store"] != false || body["stream"] != true || r.Header.Get("Accept") != "text/event-stream" {
						t.Error("wrong stream request", body)
					}
					if v == Codex {
						if body["instructions"] != "Use tides." || body["max_output_tokens"] != nil || r.Header.Get("ChatGPT-Account-Id") != "acct-fixture" || r.Header.Get("Originator") != "pi" || r.Header.Get("OpenAI-Beta") != "responses=experimental" || body["prompt_cache_key"] != r.Header.Get("Session-Id") || r.Header.Get("Session-Id") == "" {
							t.Error("wrong Codex request", body)
						}
						if n == 1 {
							if r.Header.Get("Authorization") != "Bearer stale" {
								t.Error("wrong initial token")
							}
							w.WriteHeader(401)
							return
						}
					} else if body["instructions"] != nil || body["max_output_tokens"] != float64(25) || r.Header.Get("originator") != "" || body["input"].([]any)[0].(map[string]any)["role"] != "system" {
						t.Error("wrong xAI request", body)
					}
					if r.Header.Get("Authorization") != "Bearer "+access {
						t.Error("fresh access token not used")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"Loopback.\"}\r\n\r\n")
					fmt.Fprint(w, `data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Loopback."}]}}`+"\n\n")
					fmt.Fprint(w, `data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":7,"output_tokens":2}}}`+"\n\n")
				default:
					t.Error("unexpected URL", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer httpFixture.Close()
			a := AuthFile(filepath.Join(t.TempDir(), "auth.json"))
			acct := "acct-fixture"
			before := Login{Type: "oauth", Access: "stale", Refresh: "refresh-one", Expires: 1}
			if v == Codex {
				before.Account = &acct
				before.Expires = uint64(time.Now().Add(time.Hour).UnixMilli())
			}
			if err := a.Set(t.Context(), string(v), &before); err != nil {
				t.Fatal(err)
			}
			c := oauthDefaults()
			c.client = httpFixture.Client()
			c.codexToken, c.xaiToken = httpFixture.URL+"/token", httpFixture.URL+"/token"
			p := provider(v, []Model{{ID: "test", MaxTokens: 25, Context: 10000, Effort: map[string]string{"low": "low"}}}, a, httpFixture.URL+"/responses", httpFixture.Client(), c)
			agent := modulartest.Agent(t, modular.WithProvider(p), modular.WithSettings(modular.Settings{"reasoning": "medium", "maxOutput": 100}), modular.WithPlugin(modular.Plugin{Name: "system", Setup: func(r *modular.Registrar) error {
				return r.OnTurnBefore(func(_ context.Context, _ modular.TurnBefore) (modular.TurnContribution, error) {
					return modular.TurnContribution{System: "Use tides."}, nil
				})
			}}))
			s, err := agent.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			var stream strings.Builder
			for ev, err := range s.PromptStream(t.Context(), "Say hello.") {
				if err != nil {
					t.Fatal(err)
				}
				if p, ok := ev.(modular.TextEvent); ok {
					stream.WriteString(p.Delta)
				}
			}
			latest, err := s.LastTurn(t.Context())
			if err != nil || latest == nil || latest.Outcome.Kind != "completed" || latest.Text != "Loopback." || stream.String() != latest.Text || latest.Usage.Input != 7 {
				t.Fatalf("got %+v, stream %s, error %v", latest, stream.String(), err)
			}
			fresh, err := a.Login(string(v))
			wantRefresh := "refresh-one"
			wantRequests := int32(1)
			if v == Codex {
				wantRefresh = "refresh-two"
				wantRequests = 2
			}
			if err != nil || fresh.Refresh != wantRefresh || fresh.Expired() || refreshes.Load() != 1 || requests.Load() != wantRequests {
				t.Fatalf("unexpected refresh: %v, %v (refresh=%d request=%d)", fresh, err, refreshes.Load(), requests.Load())
			}
		})
	}
}

func TestProviderDataNeverCrossesVendors(t *testing.T) {
	m := Model{ID: "test", MaxTokens: 50, Effort: map[string]string{"low": "low"}}
	obj := map[string]any{"provider": Codex, "output": []any{map[string]any{"type": "reasoning", "encrypted_content": "never-cross-vendors"}, map[string]any{"type": "function_call", "call_id": "vendor-id", "name": "read", "arguments": "{}"}}}
	r := modular.ModelRequest{Messages: []modular.Message{{Role: "assistant", ProviderData: raw(obj), Content: modular.Content{{Type: "toolCall", Fields: map[string]json.RawMessage{"id": raw("agent-id"), "name": raw("read"), "arguments": json.RawMessage(`{}`)}}}}}, Settings: modular.Settings{"reasoning": "high"}}
	codex := string(raw(requestBody(Codex, m, r)))
	xai := string(raw(requestBody(Xai, m, r)))
	if !strings.Contains(codex, "never-cross-vendors") || strings.Contains(codex, "vendor-id") || strings.Contains(xai, "never-cross-vendors") || !strings.Contains(xai, "agent-id") || !strings.Contains(codex, `"effort":"low"`) {
		t.Fatalf("unexpected replay\nCodex %s\nxAI %s", codex, xai)
	}
}
