package subscription

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

func jwt() string {
	return "fixture." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-fixture"}}`)) + ".fixture"
}

func fixtureTokens(w http.ResponseWriter) {
	_ = json.NewEncoder(w).Encode(map[string]any{"access_token": jwt(), "refresh_token": "fixture-refresh", "expires_in": 3600})
}

func TestChatGPTBrowserSignIn(t *testing.T) {
	for _, form := range []string{"redirect", "address", "query", "hash", "bare"} {
		t.Run(form, func(t *testing.T) {
			var challenge, redirect string
			token := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				hash := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
				if r.Form.Get("code") != "fixture-code" || r.Form.Get("redirect_uri") != redirect || base64.RawURLEncoding.EncodeToString(hash[:]) != challenge {
					t.Error("wrong token exchange")
				}
				fixtureTokens(w)
			}))
			defer token.Close()
			c := oauthDefaults()
			c.codexToken = token.URL
			c.listen = token.Listener.Addr().String() // Occupied for the paste paths.
			c.wait = time.Second
			if form == "redirect" {
				c.listen = "127.0.0.1:0"
			}
			var state string
			var notes int
			configured := "Go.Fixture_2-0"
			opts := SignInOptions{OnStep: func(step SignInStep) {
				if step.Note != "" {
					notes++
					return
				}
				u, err := url.Parse(step.URL)
				if err != nil {
					t.Fatal(err)
				}
				q := u.Query()
				want := "modular-agent"
				if form == "query" {
					want = configured
				}
				if u.Host != "auth.openai.com" || u.Path != "/oauth/authorize" || q.Get("originator") != want || q.Get("scope") != "openid profile email offline_access" || q.Get("client_id") != codexClient || q.Get("code_challenge_method") != "S256" || q.Get("id_token_add_organizations") != "true" || q.Get("codex_cli_simplified_flow") != "true" {
					t.Error("wrong authorize address")
				}
				state, challenge, redirect = q.Get("state"), q.Get("code_challenge"), q.Get("redirect_uri")
				if state == "" || challenge == "" {
					t.Error("missing PKCE or state")
				}
			}}
			logins := SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
			if form == "query" {
				opts.ClientIdentity = &configured
			}
			if form != "redirect" {
				i := 0
				opts.Paste = func(context.Context) (string, error) {
					i++
					if i == 1 {
						return "code=old&state=wrong", nil
					}
					if i == 2 {
						return "error=access_denied", nil
					}
					switch form {
					case "address":
						return redirect + "?code=fixture-code&state=" + state, nil
					case "query":
						return "code=fixture-code&state=" + state, nil
					case "hash":
						return "fixture-code#" + state, nil
					default:
						return "fixture-code", nil
					}
				}
				if err := c.signIn(t.Context(), "chatgpt", logins, opts); err != nil {
					t.Fatal(err)
				}
				if notes != 3 {
					t.Fatalf("got %d notes; want busy port, wrong state and denied return", notes)
				}
			} else {
				l, err := net.Listen("tcp4", c.listen)
				if err != nil {
					t.Fatal(err)
				}
				c.redirect = "http://" + l.Addr().String() + "/auth/callback"
				show := opts.OnStep
				login, err := c.browser(t.Context(), l, nil, func(step SignInStep) {
					show(step)
					for _, s := range []string{"wrong", state} {
						res, err := token.Client().Get(redirect + "?code=fixture-code&state=" + s)
						if err != nil {
							t.Fatal(err)
						}
						res.Body.Close()
						if (res.StatusCode == 200) != (s == state) {
							t.Errorf("callback status %d", res.StatusCode)
						}
					}
				}, "modular-agent")
				if err != nil || login.Account == nil {
					t.Fatal("loopback sign-in failed", err)
				}
				return
			}
			login, err := logins.Login("chatgpt")
			if err != nil || login == nil || login.Account == nil || *login.Account != "acct-fixture" || login.Refresh != "fixture-refresh" || time.Until(time.UnixMilli(int64(login.Expires))) > 55*time.Minute {
				t.Fatal("missing account, refresh or expiry margin", err)
			}
			if err := SignOut(t.Context(), "chatgpt", logins); err != nil {
				t.Fatal(err)
			}
			if l, err := logins.Login("chatgpt"); err != nil || l != nil {
				t.Fatal("sign-out did not remove login", err)
			}
		})
	}
}

func TestChatGPTDeviceSignIn(t *testing.T) {
	for _, device := range []bool{true, false} {
		t.Run(fmt.Sprint(device), func(t *testing.T) {
			polls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/device":
					var b map[string]string
					_ = json.NewDecoder(r.Body).Decode(&b)
					if b["client_id"] != codexClient {
						t.Error("wrong device client")
					}
					fmt.Fprint(w, `{"device_auth_id":"fixture-device","user_code":"FIXTURE","interval":"1"}`)
				case "/poll":
					var b map[string]string
					_ = json.NewDecoder(r.Body).Decode(&b)
					if b["device_auth_id"] != "fixture-device" || b["user_code"] != "FIXTURE" {
						t.Error("wrong device poll")
					}
					polls++
					if polls == 1 {
						w.WriteHeader(403)
						return
					}
					fmt.Fprint(w, `{"authorization_code":"fixture-auth","code_verifier":"fixture-verifier"}`)
				case "/token":
					_ = r.ParseForm()
					if r.Form.Get("code") != "fixture-auth" || r.Form.Get("code_verifier") != "fixture-verifier" || r.Form.Get("redirect_uri") != codexDeviceRedirect {
						t.Error("wrong device exchange")
					}
					fixtureTokens(w)
				default:
					t.Error("unexpected request", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer srv.Close()
			c := oauthDefaults()
			c.listen = srv.Listener.Addr().String()
			c.codexDevice, c.codexPoll, c.codexToken = srv.URL+"/device", srv.URL+"/poll", srv.URL+"/token"
			c.unit = time.Millisecond
			logins := SubscriptionLogins(filepath.Join(t.TempDir(), "auth.json"))
			var code, waiting bool
			err := c.signIn(t.Context(), "chatgpt", logins, SignInOptions{Device: device, OnStep: func(s SignInStep) {
				if s.Kind == DeviceCode && s.Code != "" {
					code = s.Code == "FIXTURE" && s.URL == "https://auth.openai.com/codex/device"
				}
				if s.Kind == Waiting {
					waiting = true
				}
			}})
			if err != nil || !code || !waiting || polls != 2 {
				t.Fatal("device sign-in did not complete", err)
			}
		})
	}
}
