package subscription_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

const (
	grokClient = "b1a00492-073a-47ea-816f-4c329264a828"
	grokDevice = "https://auth.x.ai/oauth2/device/code"
	grokToken  = "https://auth.x.ai/oauth2/token"
	grokModel  = "https://api.x.ai/v1/responses"
	grokPage   = "https://accounts.x.ai/oauth2/device"
	grokStream = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\"}\n\n" +
		`data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"fixture-opaque"}}` + "\n\n" +
		`data: {"type":"response.completed","response":{"output":[{"type":"reasoning","encrypted_content":"fixture-opaque"},{"type":"message","content":[{"type":"output_text","text":"fixture"}]}]}}` + "\n\n"
)

func checkGrokForm(t *testing.T, r *http.Request, want url.Values) {
	t.Helper()
	if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Error("expected a form POST")
	}
	if err := r.ParseForm(); err != nil || !reflect.DeepEqual(r.Form, want) {
		t.Errorf("wrong form for %s: %v", r.URL.Path, err)
	}
}

func TestGrokSignIn(t *testing.T) {
	custom := "test.client_01"
	for _, tc := range []struct {
		name, deviceFields, page, failure string
		fallback                          string
		identity                          *string
		answers                           []string
		polls                             []int
	}{
		{name: "default", page: grokPage, answers: []string{"authorization_pending", "slow_down", "slow_down", ""}, polls: []int{5, 10, 20, 35}},
		{name: "configured", deviceFields: `,"verification_uri_complete":"` + grokPage + `?user_code=code","interval":2`, page: grokPage + "?user_code=code", identity: &custom, answers: []string{""}, polls: []int{2}},
		{name: "access_denied", page: grokPage, failure: "was denied", answers: []string{"access_denied"}, polls: []int{5}},
		{name: "authorization_denied", page: grokPage, failure: "was denied", answers: []string{"authorization_denied"}, polls: []int{5}},
		{name: "expired_token", page: grokPage, failure: "code expired", answers: []string{"expired_token"}, polls: []int{5}},
		{name: "device_deadline", deviceFields: `,"expires_in":10`, page: grokPage, failure: "not completed in time", answers: []string{"authorization_pending"}, polls: []int{5}},
		{name: "default_deadline", deviceFields: `,"interval":900`, page: grokPage, failure: "not completed in time"},
		{name: "refuse_http", deviceFields: `,"verification_uri_complete":"http://accounts.x.ai/oauth2/device"`, failure: "is not https"},
		{name: "refuse_http_fallback", fallback: "http://accounts.x.ai/oauth2/device", failure: "is not https"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logins := subscription.SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
			synctest.Test(t, func(t *testing.T) {
				start := time.Now()
				var steps []subscription.SignInStep
				var polls []int
				starts := 0
				transport := roundTrip(func(r *http.Request) (*http.Response, error) {
					switch r.URL.String() {
					case grokDevice:
						starts++
						identity := "modular-agent"
						if tc.identity != nil {
							identity = *tc.identity
						}
						checkGrokForm(t, r, url.Values{"client_id": {grokClient}, "scope": {"openid profile email offline_access grok-cli:access api:access"}, "referrer": {identity}})
						fallback := tc.fallback
						if fallback == "" {
							fallback = grokPage
						}
						return reply(200, `{"verification_uri":"`+fallback+`","user_code":"code","device_code":"device"`+tc.deviceFields+`}`)
					case grokToken:
						checkGrokForm(t, r, url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "client_id": {grokClient}, "device_code": {"device"}})
						i := len(polls)
						polls = append(polls, int(time.Since(start)/time.Second))
						if i >= len(tc.answers) || len(steps) != 2 || steps[1].Kind != subscription.Waiting {
							return nil, errors.New("unexpected poll")
						}
						if answer := tc.answers[i]; answer != "" {
							return reply(400, fmt.Sprintf(`{"error":%q}`, answer))
						}
						return reply(200, `{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":1800}`)
					default:
						return nil, errors.New("unexpected fixture destination")
					}
				})
				err := subscription.SignIn(t.Context(), "grok", logins, subscription.SignInOptions{
					Device: tc.identity != nil, ClientIdentity: tc.identity, HTTPTransport: transport,
					OnStep: func(s subscription.SignInStep) { steps = append(steps, s) },
					Paste: func(context.Context) (string, error) {
						t.Error("Grok asked for pasted input")
						return "", errors.New("unexpected paste")
					},
				})
				if starts != 1 || !slices.Equal(polls, tc.polls) {
					t.Fatalf("got %d starts and polls at %v; want one start and polls at %v", starts, polls, tc.polls)
				}
				var wantSteps []subscription.SignInStep
				if tc.page != "" {
					wantSteps = []subscription.SignInStep{{Kind: subscription.DeviceCode, URL: tc.page, Code: "code"}, {Kind: subscription.Waiting}}
				}
				if !slices.Equal(steps, wantSteps) {
					t.Fatalf("steps = %+v, want %+v", steps, wantSteps)
				}
				login, readErr := logins.Login("grok")
				if readErr != nil {
					t.Fatal(readErr)
				}
				if tc.failure != "" {
					if err == nil || !strings.Contains(err.Error(), tc.failure) || login != nil {
						t.Fatalf("wanted %q and no login, got %v", tc.failure, err)
					}
					return
				}
				wantLogin := subscription.Login{Type: "oauth", Access: "fixture-access", Refresh: "fixture-refresh", Expires: uint64(time.Now().Add(25 * time.Minute).UnixMilli())}
				if err != nil || login == nil || *login != wantLogin {
					t.Fatal("wrong saved login", err)
				}
			})
		})
	}
}

func TestGrokIdentityValidation(t *testing.T) {
	logins := subscription.SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
	for _, label := range []string{"", "bad label", "label/", "é", strings.Repeat("x", 65)} {
		_, err := subscription.Grok(subscription.GrokOptions{Logins: logins, ClientIdentity: &label})
		var e *modular.Error
		if !errors.As(err, &e) || e.Code != modular.InvalidComposition {
			t.Fatal(err)
		}
		err = subscription.SignIn(t.Context(), "grok", logins, subscription.SignInOptions{ClientIdentity: &label, HTTPTransport: roundTrip(func(*http.Request) (*http.Response, error) {
			t.Error("invalid identity reached the transport")
			return nil, errors.New("unexpected request")
		})})
		if !errors.As(err, &e) || e.Code != modular.InvalidParams {
			t.Fatal(err)
		}
	}
}

func grokPlacements(t *testing.T, run func(*testing.T, func(modular.Provider) modular.Option)) {
	t.Helper()
	t.Run("inProcess", func(t *testing.T) { run(t, modular.WithProvider) })
	t.Run("overWire", func(t *testing.T) {
		run(t, func(p modular.Provider) modular.Option {
			return modulartest.OverWire(modular.Plugin{Name: "grok", Setup: func(r *modular.Registrar) error { return r.Provider(p) }})
		})
	})
}

func TestGrokProviderPlacements(t *testing.T) {
	grokPlacements(t, func(t *testing.T, place func(modular.Provider) modular.Option) {
		path := filepath.Join(t.TempDir(), "auth.json")
		logins := subscription.SubscriptionLogins(path)
		var requests atomic.Int32
		var refreshes atomic.Int32
		var modelErr atomic.Pointer[modular.ModelError]
		identity := "test.client_01"
		p, err := subscription.Grok(subscription.GrokOptions{Logins: logins, ClientIdentity: &identity,
			Models: []modular.ModelInfo{{ModelRef: modular.ModelRef{ID: "unlisted"}, ContextWindow: 8192, MaxOutput: 1024, Input: []string{"text"}, Thinking: []string{"high"}}},
			HTTPTransport: roundTrip(func(r *http.Request) (*http.Response, error) {
				if r.URL.String() == grokToken {
					checkGrokForm(t, r, url.Values{"grant_type": {"refresh_token"}, "client_id": {grokClient}, "refresh_token": {"fixture-refresh"}})
					switch refreshes.Add(1) {
					case 1:
						return reply(200, `{"access_token":"fixture-access"}`)
					case 2:
						return reply(400, `{"error":"invalid_grant","error_description":"fixture-refresh"}`)
					default:
						return nil, errors.New("unexpected refresh")
					}
				}
				if r.URL.String() != grokModel {
					return nil, errors.New("unexpected fixture destination")
				}
				if r.Method != http.MethodPost || len(r.Header) != 2 || r.Header.Get("Authorization") != "Bearer fixture-access" || r.Header.Get("Accept") != "text/event-stream" {
					t.Error("wrong Grok request headers")
				}
				var body struct {
					Model              string
					Stream             bool
					Store              *bool
					Include            []string
					Input              []map[string]any
					Reasoning          map[string]string
					MaxOutput          int    `json:"max_output_tokens"`
					Choice             string `json:"tool_choice"`
					Parallel           bool   `json:"parallel_tool_calls"`
					Instructions, Text json.RawMessage
					PromptCacheKey     json.RawMessage `json:"prompt_cache_key"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					return nil, err
				}
				if !body.Stream || body.Store == nil || *body.Store || !slices.Equal(body.Include, []string{"reasoning.encrypted_content"}) || body.Choice != "auto" || !body.Parallel || body.Instructions != nil || body.Text != nil || body.PromptCacheKey != nil {
					t.Error("wrong Grok Responses body")
				}
				if len(body.Input) < 2 || !reflect.DeepEqual(body.Input[0], map[string]any{"role": "system", "content": "fixture system"}) || body.Input[len(body.Input)-1]["role"] != "user" {
					t.Error("missing or out-of-order input")
				}
				replayed := slices.ContainsFunc(body.Input, func(m map[string]any) bool { return m["encrypted_content"] == "fixture-opaque" })
				n := requests.Add(1)
				switch n {
				case 1, 2:
					if body.Model != "grok-4.3" || body.MaxOutput != 30000 || !reflect.DeepEqual(body.Reasoning, map[string]string{"effort": "none", "summary": "auto"}) || replayed != (n == 2) {
						t.Error("wrong cap, reasoning mapping or replay")
					}
				case 3:
					if body.Model != "unlisted" || body.MaxOutput != 400 || body.Reasoning != nil || replayed {
						t.Error("wrong request for an enrolled model")
					}
				default:
					t.Error("unexpected model request")
				}
				return reply(200, grokStream)
			})})
		if err != nil || p.ID != "grok" || p.Available() {
			t.Fatal("wrong Provider or available without login", err)
		}
		old := subscription.Login{Type: "oauth", Access: "stale-access", Refresh: "fixture-refresh", Expires: 1}
		if err := logins.Set(t.Context(), "grok", &old); err != nil || !p.Available() {
			t.Fatal("saved login not available", err)
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
		a := modulartest.Agent(t, modular.WithModel("grok/grok-4.3"), place(p), observe, modular.WithSettings(modular.Settings{"reasoning": "off", "maxOutput": 40000}))
		checkGrokCatalog(t, a.Models())
		s, err := a.Session(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		before := time.Now()
		promptGrok(t, s)
		promptGrok(t, s)
		fresh, err := logins.Login("grok")
		expiry := 55 * time.Minute // 3600 seconds minus the five-minute margin.
		if err != nil || fresh == nil || fresh.Access != "fixture-access" || fresh.Refresh != old.Refresh || fresh.Account != nil || fresh.Expires < uint64(before.Add(expiry).UnixMilli()) || fresh.Expires > uint64(time.Now().Add(expiry).UnixMilli()) {
			t.Fatal("refresh did not retain the refresh token or default the expiry", err)
		}
		s, err = a.Session(t.Context(), modular.SessionOptions{Settings: modular.Settings{"model": "grok/unlisted", "reasoning": "high", "maxOutput": 400}})
		if err != nil {
			t.Fatal(err)
		}
		promptGrok(t, s)
		if err := logins.Set(t.Context(), "grok", &old); err != nil {
			t.Fatal(err)
		}
		original, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		out, err := s.Prompt(t.Context(), "refuse refresh")
		if e := modelErr.Load(); err != nil || out.Outcome == nil || out.Outcome.Kind != "failed" || e == nil || e.Kind != modular.Credentials || !strings.Contains(e.Message, "sign in again") || strings.Contains(e.Message, "fixture-refresh") {
			t.Fatal("wanted a safe credentials failure", e, err)
		}
		if after, err := os.ReadFile(path); err != nil || !bytes.Equal(after, original) {
			t.Fatal("refused refresh changed the login", err)
		}
		if requests.Load() != 3 || refreshes.Load() != 2 {
			t.Fatal("wrong count of model or token requests")
		}
		if err := subscription.SignOut(t.Context(), "grok", logins); err != nil || p.Available() {
			t.Fatal("login survived sign-out", err)
		}
	})
}

func checkGrokCatalog(t *testing.T, models []modular.ModelInfo) {
	t.Helper()
	for _, want := range []struct {
		id              string
		context, output int
		thinking        []string
	}{
		{"grok-4.3", 1000000, 30000, []string{"off", "low", "medium", "high", "xhigh"}},
		{"grok-4.5", 500000, 500000, []string{"low", "medium", "high", "xhigh"}},
		{"grok-4.6", 500000, 500000, []string{"low", "medium", "high", "xhigh"}},
		{"grok-4.7", 500000, 500000, []string{"low", "medium", "high", "xhigh"}},
		{"unlisted", 8192, 1024, nil},
	} {
		i := slices.IndexFunc(models, func(m modular.ModelInfo) bool { return m.Provider == "grok" && m.ID == want.id })
		if i < 0 || models[i].ContextWindow != want.context || models[i].MaxOutput != want.output || !slices.Equal(models[i].Thinking, want.thinking) {
			t.Errorf("wrong catalog entry for %s", want.id)
		}
	}
}

func promptGrok(t *testing.T, s *modular.Session) {
	t.Helper()
	var text strings.Builder
	for e, err := range s.PromptStream(t.Context(), "hello") {
		if err != nil {
			t.Fatal(err)
		}
		if event, ok := e.(modular.TextEvent); ok {
			text.WriteString(event.Delta)
		}
	}
	out, err := s.LastTurn(t.Context())
	if err != nil || out == nil || out.Outcome == nil || out.Outcome.Kind != "completed" || out.Text != "fixture" || text.String() != out.Text {
		t.Fatalf("Grok stream did not complete with matching text: %+v, %v", out, err)
	}
}

func TestGrokConcurrentRefresh(t *testing.T) {
	grokPlacements(t, func(t *testing.T, place func(modular.Provider) modular.Option) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		path := filepath.Join(t.TempDir(), "auth.json")
		logins := subscription.SubscriptionLogins(path)
		if err := logins.Set(ctx, "grok", &subscription.Login{Type: "oauth", Refresh: "one", Access: "old", Expires: 1}); err != nil {
			t.Fatal(err)
		}
		var refreshes atomic.Int32
		started, second, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
		defer close(release)
		transport := roundTrip(func(r *http.Request) (*http.Response, error) {
			switch r.URL.String() {
			case grokToken:
				checkGrokForm(t, r, url.Values{"grant_type": {"refresh_token"}, "client_id": {grokClient}, "refresh_token": {"one"}})
				if refreshes.Add(1) != 1 {
					return reply(400, `{"error":"invalid_grant"}`)
				}
				close(started)
				select {
				case <-r.Context().Done():
					return nil, r.Context().Err()
				case <-release:
					return reply(200, `{"access_token":"new","refresh_token":"two"}`)
				}
			case grokModel:
				if r.Header.Get("Authorization") != "Bearer new" {
					t.Error("request did not use the refreshed token")
				}
				return reply(200, grokStream)
			default:
				return nil, errors.New("unexpected fixture destination")
			}
		})
		sessions := make([]*modular.Session, 2)
		for i := range sessions {
			p, err := subscription.Grok(subscription.GrokOptions{Logins: subscription.SubscriptionLogins(path), HTTPTransport: transport})
			if err != nil {
				t.Fatal(err)
			}
			if i == 1 {
				request := p.Request
				p.Request = func(ctx context.Context, ref modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
					close(second)
					return request(ctx, ref, r, pc)
				}
			}
			a := modulartest.Agent(t, modular.WithModel("grok/grok-4.7"), place(p))
			sessions[i], err = a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
		}
		done := make(chan error, 2)
		prompt := func(s *modular.Session) {
			out, err := s.Prompt(ctx, "hello")
			if err == nil && (out.Outcome == nil || out.Outcome.Kind != "completed") {
				err = errors.New("prompt did not complete")
			}
			done <- err
		}
		go prompt(sessions[0])
		select {
		case <-started:
		case err := <-done:
			t.Fatal("first request ended before refresh", err)
		}
		go prompt(sessions[1])
		select {
		case <-second:
		case err := <-done:
			t.Fatal("second request ended before reaching the Provider", err)
		}
		lock, err := os.OpenFile(filepath.Join(filepath.Dir(path), "auth.lock"), os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); !errors.Is(err, syscall.EWOULDBLOCK) {
			t.Fatal("refresh did not hold the file lock while awaiting tokens", err)
		}
		release <- struct{}{}
		for range sessions {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		login, err := logins.Login("grok")
		if refreshes.Load() != 1 || err != nil || login == nil || login.Refresh != "two" {
			t.Fatal("concurrent requests did not share one refresh result", err)
		}
	})
}
