package grok

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

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

func TestResponsesRequestsAndRefresh(t *testing.T) {
	var requests, refreshes atomic.Int32
	access := "new-access"
	httpFixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			refreshes.Add(1)
			_ = r.ParseForm()
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("client_id") != xaiClient || r.Form.Get("refresh_token") != "refresh-one" {
				t.Error("wrong refresh form")
			}
			b := map[string]any{"access_token": access, "expires_in": 3600}
			_ = json.NewEncoder(w).Encode(b)
		case "/responses":
			requests.Add(1)
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["store"] != false || body["stream"] != true || r.Header.Get("Accept") != "text/event-stream" {
				t.Error("wrong stream request", body)
			}
			if body["instructions"] != nil || body["max_output_tokens"] != float64(25) || r.Header.Get("originator") != "" || body["input"].([]any)[0].(map[string]any)["role"] != "system" {
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
	a := subscription.SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
	before := subscription.Login{Type: "oauth", Access: "stale", Refresh: "refresh-one", Expires: 1}
	if err := a.Set(t.Context(), ID, &before); err != nil {
		t.Fatal(err)
	}
	c := oauthDefaults()
	c.client, c.xaiToken = httpFixture.Client(), httpFixture.URL+"/token"
	p := provider([]Model{{ID: "test", MaxTokens: 25, Context: 10000, Effort: map[string]string{"low": "low"}}}, a, httpFixture.URL+"/responses", httpFixture.Client(), c)
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
	fresh, err := a.Login(ID)
	if err != nil || fresh == nil || fresh.Refresh != "refresh-one" || fresh.Expired() || refreshes.Load() != 1 || requests.Load() != 1 {
		t.Fatal("Grok refresh did not settle", err)
	}
}

func TestProviderDataNeverCrossesVendors(t *testing.T) {
	model := Model{ID: "test", MaxTokens: 50, Effort: map[string]string{"low": "low"}}
	obj := map[string]any{"provider": "chatgpt", "output": []any{map[string]any{"type": "reasoning", "encrypted_content": "never-cross-vendors"}}}
	req := modular.ModelRequest{Messages: []modular.Message{{Role: "assistant", ProviderData: raw(obj), Content: modular.Text("kept text")}}, Settings: modular.Settings{"reasoning": "high"}}
	body := string(raw(requestBody(model, req)))
	if strings.Contains(body, "never-cross-vendors") || !strings.Contains(body, "kept text") || !strings.Contains(body, `"effort":"low"`) {
		t.Fatal("wrong provider data replay")
	}
}
