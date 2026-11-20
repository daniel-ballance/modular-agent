package subscription

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func jwt() string {
	return "fixture." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-fixture"}}`)) + ".fixture"
}

func TestDeviceSignIn(t *testing.T) {
	for _, v := range []Vendor{Codex, Xai} {
		t.Run(string(v), func(t *testing.T) {
			polls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/device":
					if v == Codex {
						var b map[string]string
						_ = json.NewDecoder(r.Body).Decode(&b)
						if b["client_id"] != codexClient {
							t.Error("wrong Codex client id")
						}
						fmt.Fprint(w, `{"device_auth_id":"session","user_code":"CODE","interval":"1"}`)
					} else {
						_ = r.ParseForm()
						if r.Form.Get("client_id") != xaiClient || r.Form.Get("scope") != xaiScope || r.Form.Get("referrer") != "pi" {
							t.Error("wrong xAI form")
						}
						fmt.Fprint(w, `{"device_code":"session","user_code":"CODE","verification_uri_complete":"https://fixture.invalid/device?code=CODE","interval":1,"expires_in":500}`)
					}
				case "/poll":
					polls++
					if v == Codex {
						var b map[string]string
						_ = json.NewDecoder(r.Body).Decode(&b)
						if b["device_auth_id"] != "session" || b["user_code"] != "CODE" {
							t.Error("wrong Codex poll")
						}
						if polls < 2 {
							w.WriteHeader(403)
							return
						}
						fmt.Fprint(w, `{"authorization_code":"auth","code_verifier":"verifier"}`)
					} else {
						_ = r.ParseForm()
						if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" || r.Form.Get("device_code") != "session" {
							t.Error("wrong xAI poll")
						}
						if polls == 1 {
							w.WriteHeader(400)
							fmt.Fprint(w, `{"error":"authorization_pending"}`)
							return
						}
						if polls == 2 {
							w.WriteHeader(400)
							fmt.Fprint(w, `{"error":"slow_down"}`)
							return
						}
						fmt.Fprint(w, `{"access_token":"xai-token","refresh_token":"refresh","expires_in":3600}`)
					}
				case "/token":
					_ = r.ParseForm()
					if r.Form.Get("code") != "auth" || r.Form.Get("code_verifier") != "verifier" || r.Form.Get("redirect_uri") != codexDeviceRedirect {
						t.Error("wrong code exchange")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"access_token": jwt(), "refresh_token": "refresh", "expires_in": 3600})
				default:
					t.Error("unexpected request", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			c := oauthDefaults()
			c.client = server.Client()
			c.unit = time.Millisecond
			c.wait = time.Second
			c.xaiDevice, c.codexDevice = server.URL+"/device", server.URL+"/device"
			c.xaiToken, c.codexPoll = server.URL+"/poll", server.URL+"/poll"
			c.codexToken = server.URL + "/token"
			var shown Step
			l, err := c.signIn(t.Context(), v, true, nil, func(s Step) { shown = s })
			if err != nil || shown.Code != "CODE" || l.Refresh != "refresh" || l.Expired() {
				t.Fatalf("unexpected sign-in: %v, %v, %+v", l, err, shown)
			}
			if v == Codex && (l.Account == nil || *l.Account != "acct-fixture" || polls != 2) {
				t.Fatal("wrong Codex result")
			}
			if v == Xai && (l.Account != nil || l.Secret() != "xai-token" || polls != 3) {
				t.Fatal("wrong xAI result")
			}
		})
	}
}

func TestBrowserSignInFromPasteWhenPortIsBusy(t *testing.T) {
	token := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/token" {
			t.Error("unexpected request", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_ = r.ParseForm()
		if r.Form.Get("code") != "pasted-code" || r.Form.Get("redirect_uri") != "http://localhost:1455/auth/callback" {
			t.Error("wrong pasted code or redirect URI")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": jwt(), "refresh_token": "refresh"})
	}))
	defer token.Close()
	c := oauthDefaults()
	c.client = token.Client()
	c.listen = token.Listener.Addr().String() // No callback listener can bind this port.
	c.authorize, c.codexToken, c.codexDevice = token.URL+"/authorize", token.URL+"/token", token.URL+"/unexpected"
	c.wait = time.Second
	pasted := make(chan string, 3)
	var notes []string
	l, err := c.signIn(t.Context(), Codex, false, pasted, func(step Step) {
		if step.Note != "" {
			notes = append(notes, step.Note)
			return
		}
		if !step.OpenAndPaste {
			t.Fatal("expected the paste prompt")
		}
		u, err := url.Parse(step.Address)
		if err != nil {
			t.Fatal(err)
		}
		q := u.Query()
		if q.Get("originator") != "pi" || q.Get("state") == "" {
			t.Fatal("missing client identity or state")
		}
		pasted <- ""
		pasted <- c.redirect + "?code=stale&state=other"
		pasted <- c.redirect + "?code=pasted-code&scope=x&state=" + q.Get("state")
	})
	if err != nil || l.Account == nil || *l.Account != "acct-fixture" || l.Refresh != "refresh" {
		t.Fatalf("browser login: %v, %v", l, err)
	}
	if len(notes) != 2 || !strings.Contains(notes[0], "Port 1455 is in use") ||
		!strings.Contains(notes[1], "different sign-in") || !strings.Contains(notes[1], "Paste it again") {
		t.Fatalf("unexpected notes: %v", notes)
	}
}

func TestPastedCodeForms(t *testing.T) {
	for _, tc := range []struct{ input, code, problem string }{
		{"http://localhost:1455/auth/callback?code=c1&state=st", "c1", ""},
		{"  code=a%2Fb+c&state=st  ", "a/b c", ""},
		{"c3#st", "c3", ""},
		{"c4", "c4", ""},
		{"   ", "", ""},
		{"http://localhost:1455/auth/callback?code=c&state=other", "", "different sign-in"},
		{"code=c&state=", "", "different sign-in"},
		{"http://localhost:1455/auth/callback?error=access_denied&state=st", "", "not completed"},
		{"http://localhost:1455/auth/callback?state=st", "", "no code"},
	} {
		code, err := pastedCode(tc.input, "st")
		if code != tc.code || (tc.problem == "" && err != nil) ||
			(tc.problem != "" && (err == nil || !strings.Contains(err.Error(), tc.problem))) {
			t.Errorf("paste %q: got (%q, %v), want (%q, %q)", tc.input, code, err, tc.code, tc.problem)
		}
	}
}

func TestBrowserSignInWithPKCE(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	redirect := "http://" + listener.Addr().String() + "/auth/callback"
	var challenge string
	token := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		hash := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if r.Form.Get("code") != "a/b c" || r.Form.Get("redirect_uri") != redirect || challenge != base64.RawURLEncoding.EncodeToString(hash[:]) {
			t.Error("the authorization code or PKCE pair did not round-trip")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": jwt(), "refresh_token": "refresh"})
	}))
	defer token.Close()
	c := oauthDefaults()
	c.redirect = redirect
	c.authorize = token.URL + "/authorize"
	c.codexToken = token.URL
	c.wait = time.Second
	l, err := c.browser(t.Context(), listener, nil, func(step Step) {
		u, err := url.Parse(step.Address)
		if err != nil {
			t.Error(err)
			return
		}
		q := u.Query()
		challenge = q.Get("code_challenge")
		if q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || !strings.Contains(q.Get("scope"), "offline_access") {
			t.Error("incorrect browser parameters")
		}
		for _, tc := range []struct {
			state  string
			status int
		}{{"wrong-state", 400}, {q.Get("state"), 200}} {
			res, err := token.Client().Get(redirect + "?" + url.Values{"state": {tc.state}, "code": {"a/b c"}}.Encode())
			if err != nil {
				t.Error(err)
				return
			}
			res.Body.Close()
			if res.StatusCode != tc.status {
				t.Errorf("callback status %d, expected %d", res.StatusCode, tc.status)
			}
		}
	})
	if err != nil || l.Account == nil || *l.Account != "acct-fixture" {
		t.Fatalf("browser login: %v, %v", l, err)
	}
}
