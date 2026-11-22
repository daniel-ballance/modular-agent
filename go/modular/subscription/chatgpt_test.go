package subscription_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func reply(status int, body string) (*http.Response, error) {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
}

func TestSubscriptionTableIsByteIdentical(t *testing.T) {
	a, err := os.ReadFile("subscription-models.json")
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../../docs/sdk/subscription-models.json")
	if err != nil || !bytes.Equal(a, b) {
		t.Fatal("shipped subscription table differs from the spec", err)
	}
}

func TestPublicSignInValidation(t *testing.T) {
	l := subscription.SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
	for _, label := range []string{"", "bad label", "label/", "é", strings.Repeat("x", 65)} {
		_, err := subscription.ChatGPT(subscription.ChatGPTOptions{Logins: l, ClientIdentity: &label})
		var e *modular.Error
		if !errors.As(err, &e) || e.Code != modular.InvalidComposition {
			t.Fatal(err)
		}
		err = subscription.SignIn(t.Context(), "chatgpt", l, subscription.SignInOptions{ClientIdentity: &label})
		if !errors.As(err, &e) || e.Code != modular.InvalidParams {
			t.Fatal(err)
		}
	}
}

func TestChatGPTProviderPlacements(t *testing.T) {
	for _, wire := range []bool{false, true} {
		name := "inProcess"
		if wire {
			name = "overWire"
		}
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "auth.json")
			logins := subscription.SubscriptionLogins(path)
			account := "fixture-account"
			original := subscription.Login{Type: "oauth", Access: "fixture-access", Refresh: "fixture-refresh", Account: &account, Expires: uint64(time.Now().Add(time.Hour).UnixMilli())}
			var requests atomic.Int32
			var refused atomic.Bool
			var modelErr atomic.Pointer[modular.ModelError]
			custom := "test.client_01"
			opts := subscription.ChatGPTOptions{Logins: logins, Models: []modular.ModelInfo{{ModelRef: modular.ModelRef{ID: "unlisted"}, ContextWindow: 8192, MaxOutput: 2048, Input: []string{"text"}, Thinking: []string{"high"}}}}
			if wire {
				opts.ClientIdentity = &custom
			}
			opts.HTTPTransport = roundTrip(func(r *http.Request) (*http.Response, error) {
				if r.URL.String() == "https://auth.openai.com/oauth/token" {
					_ = r.ParseForm()
					if !refused.Load() || r.Form.Get("refresh_token") != "fixture-refresh" {
						t.Error("unexpected refresh")
					}
					return reply(400, `{"error":"invalid_grant","error_description":"fixture-refresh"}`)
				}
				if r.URL.String() != "https://chatgpt.com/backend-api/codex/responses" {
					return nil, fmt.Errorf("unexpected fixture destination")
				}
				want := "modular-agent"
				if wire {
					want = custom
				}
				session := r.Header.Get("Session-Id")
				if session == "" || r.Header.Get("X-Client-Request-Id") != session || r.Header.Get("ChatGPT-Account-Id") != account || r.Header.Get("Authorization") != "Bearer fixture-access" || r.Header.Get("Originator") != want || r.Header.Get("OpenAI-Beta") != "responses=experimental" {
					t.Error("wrong request headers")
				}
				var body struct {
					Model, Instructions string
					CacheKey            string `json:"prompt_cache_key"`
					Stream, Store       bool
					Include             []string
					Reasoning           map[string]string
					MaxOutput           any `json:"max_output_tokens"`
					Input               []map[string]any
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					return nil, err
				}
				if !body.Stream || body.Store || body.Instructions != "fixture system" || body.CacheKey != session || body.MaxOutput != nil || !slices.Equal(body.Include, []string{"reasoning.encrypted_content"}) {
					t.Error("wrong Responses body")
				}
				switch requests.Add(1) {
				case 1:
					if body.Model != "gpt-6.1-sol" || body.Reasoning != nil {
						t.Error("unsupported off must be omitted")
					}
				case 2:
					if body.Reasoning["effort"] != "low" || body.Reasoning["summary"] != "auto" {
						t.Error("wrong minimal mapping")
					}
					if !slices.ContainsFunc(body.Input, func(item map[string]any) bool { return item["encrypted_content"] == "fixture-opaque" }) {
						t.Error("encrypted reasoning was not replayed")
					}
				case 3:
					if body.Model != "unlisted" || body.Reasoning != nil {
						t.Error("enrolled model got guessed controls")
					}
				case 4:
					if body.Reasoning != nil {
						t.Error("unset level was sent")
					}
				default:
					t.Error("unexpected request")
				}
				return reply(200, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\"}\n\n"+`data: {"type":"response.completed","response":{"output":[{"type":"reasoning","encrypted_content":"fixture-opaque"},{"type":"message","content":[{"type":"output_text","text":"fixture"}]}]}}`+"\n\n")
			})
			p, err := subscription.ChatGPT(opts)
			if err != nil || p.Available() {
				t.Fatal("missing login was available", err)
			}
			if err := logins.Set(t.Context(), "chatgpt", &original); err != nil {
				t.Fatal(err)
			}
			if !p.Available() {
				t.Fatal("saved login not available")
			}
			use := modular.WithProvider(p)
			if wire {
				use = modulartest.OverWire(modular.Plugin{Name: "chatgpt", Setup: func(r *modular.Registrar) error { return r.Provider(p) }})
			}
			observe := modular.WithPlugin(modular.Plugin{Name: "observe", Setup: func(r *modular.Registrar) error {
				if err := r.OnProviderRequest(func(_ context.Context, r modular.ProviderRequest) (*modular.ModelRequest, error) {
					r.Request.SystemPrompt = "fixture system"
					return &r.Request, nil
				}); err != nil {
					return err
				}
				return r.OnModelFailed(func(_ context.Context, r modular.ModelFailed) (*modular.RetryDecision, error) {
					modelErr.Store(&r.Error)
					return nil, nil
				})
			}})
			a, err := modular.New(t.Context(), modular.WithProject(t.TempDir()), modular.WithModel("chatgpt/gpt-6.1-sol"), use, observe)
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(t.Context())
			all := a.Models()
			i := slices.IndexFunc(all, func(m modular.ModelInfo) bool { return m.ID == "gpt-6.1-sol" })
			if i < 0 || all[i].ContextWindow != 500000 || all[i].MaxOutput != 128000 || !slices.Equal(all[i].Thinking, []string{"minimal", "low", "medium", "high", "xhigh"}) {
				t.Fatal("wrong plan catalog", all)
			}
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			for _, spec := range []struct{ model, level string }{{"gpt-6.1-sol", "off"}, {"gpt-6.1-sol", "minimal"}, {"unlisted", "high"}, {"gpt-6.1-sol", ""}} {
				if spec.level == "" {
					s, err = a.Session(t.Context())
					if err != nil {
						t.Fatal(err)
					}
				}
				if err := s.SetSetting(t.Context(), "model", "chatgpt/"+spec.model); err != nil {
					t.Fatal(err)
				}
				if spec.level != "" {
					if err := s.SetSetting(t.Context(), "reasoning", spec.level); err != nil {
						t.Fatal(err)
					}
				}
				var text string
				for e, err := range s.PromptStream(t.Context(), "hello") {
					if err != nil {
						t.Fatal(err)
					}
					if event, ok := e.(modular.TextEvent); ok {
						text += event.Delta
					}
				}
				out, err := s.LastTurn(t.Context())
				if err != nil || out == nil || out.Outcome == nil || out.Outcome.Kind != "completed" || text != "fixture" || out.Text != text {
					t.Fatalf("stream failed: %+v, %v", out, err)
				}
			}
			refused.Store(true)
			original.Expires = 1
			if err := logins.Set(t.Context(), "chatgpt", &original); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			out, err := s.Prompt(t.Context(), "refuse refresh")
			e := modelErr.Load()
			if err != nil || out.Outcome == nil || out.Outcome.Kind != "failed" || e == nil || e.Kind != modular.Credentials || !strings.Contains(e.Message, "sign in again") || strings.Contains(e.Message, "fixture-refresh") {
				t.Fatalf("refresh should yield a safe credentials failure: %v %v", e, err)
			}
			if after, err := os.ReadFile(path); err != nil || !bytes.Equal(before, after) {
				t.Fatal("refused refresh changed the login", err)
			}
		})
	}
}

func TestPublicChatGPTDeviceSignIn(t *testing.T) {
	logins := subscription.SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
	access := "fixture." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"fixture"}}`)) + ".fixture"
	custom := "fixture"
	var steps []subscription.SignInStepKind
	err := subscription.SignIn(t.Context(), "chatgpt", logins, subscription.SignInOptions{Device: true, ClientIdentity: &custom, OnStep: func(s subscription.SignInStep) { steps = append(steps, s.Kind) }, HTTPTransport: roundTrip(func(r *http.Request) (*http.Response, error) {
		switch r.URL.String() {
		case "https://auth.openai.com/api/accounts/deviceauth/usercode":
			return reply(200, `{"device_auth_id":"fake-id","user_code":"fake-code","interval":1}`)
		case "https://auth.openai.com/api/accounts/deviceauth/token":
			return reply(200, `{"authorization_code":"fake-code","code_verifier":"fake-verifier"}`)
		case "https://auth.openai.com/oauth/token":
			return reply(200, fmt.Sprintf(`{"access_token":%q,"refresh_token":"fixture"}`, access))
		default:
			return nil, errors.New("unexpected fixture endpoint")
		}
	})})
	if err != nil || !slices.Equal(steps, []subscription.SignInStepKind{subscription.DeviceCode, subscription.Waiting}) {
		t.Fatal("device steps did not complete", err)
	}
	l, err := logins.Login("chatgpt")
	if err != nil || l == nil || l.Account == nil || *l.Account != "fixture" {
		t.Fatal("missing login", err)
	}
}
