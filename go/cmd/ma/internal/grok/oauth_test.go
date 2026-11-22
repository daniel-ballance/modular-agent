package grok

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGrokDeviceSignIn(t *testing.T) {
	custom, err := ParseClientIdentity("My-agent_2.0")
	if err != nil {
		t.Fatal(err)
	}
	for _, identity := range []ClientIdentity{{}, custom} {
		t.Run(identity.name(), func(t *testing.T) {
			polls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				if r.Form.Get("client_id") != xaiClient {
					t.Error("wrong xAI client id")
				}
				switch r.URL.Path {
				case "/device":
					if r.Form.Get("referrer") != identity.name() || r.Form.Get("scope") != xaiScope {
						t.Error("wrong device authorization form")
					}
					fmt.Fprint(w, `{"device_code":"session","user_code":"CODE","verification_uri_complete":"https://fixture.invalid/device?code=CODE","interval":1,"expires_in":500}`)
				case "/poll":
					if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" || r.Form.Get("device_code") != "session" {
						t.Error("wrong device poll")
					}
					polls++
					if polls < 3 {
						w.WriteHeader(400)
						if polls == 1 {
							fmt.Fprint(w, `{"error":"authorization_pending"}`)
						} else {
							fmt.Fprint(w, `{"error":"slow_down"}`)
						}
						return
					}
					fmt.Fprint(w, `{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}`)
				default:
					t.Error("unexpected endpoint", r.URL.Path)
				}
			}))
			defer srv.Close()
			c := oauthDefaults()
			c.client, c.unit, c.xaiDevice, c.xaiToken = srv.Client(), time.Millisecond, srv.URL+"/device", srv.URL+"/poll"
			var shown Step
			login, err := c.signIn(t.Context(), func(s Step) { shown = s }, identity)
			if err != nil || login.Expired() || login.Secret() != "fixture-access" || login.Refresh != "fixture-refresh" || login.Account != nil || shown.Code != "CODE" || !strings.HasPrefix(shown.Address, "https://fixture.invalid/") || polls != 3 {
				t.Fatal("wrong sign-in result", err)
			}
		})
	}
}
