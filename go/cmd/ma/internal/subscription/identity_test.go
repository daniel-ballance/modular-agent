package subscription

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestClientIdentityValidation(t *testing.T) {
	for _, value := range []string{"", strings.Repeat("x", 65), "two words", "name/", "name\n", "café"} {
		if _, err := ParseClientIdentity(value); err == nil {
			t.Errorf("accepted invalid client identity %q", value)
		}
	}
	for _, value := range []string{"A", "My-agent_2.0", strings.Repeat("x", 64)} {
		if _, err := ParseClientIdentity(value); err != nil {
			t.Errorf("rejected valid client identity %q: %v", value, err)
		}
	}
}

func TestClientIdentityOnRequestsAndSignIn(t *testing.T) {
	const custom = "My-agent_2.0"
	identity, err := ParseClientIdentity(custom)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		opts Options
		want string
	}{
		{"default", Options{}, "modular-agent"},
		{"configured", Options{ClientIdentity: identity}, custom},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Run("ChatGPT request", func(t *testing.T) {
				req, err := newResponsesRequest(t.Context(), Codex, Codex.endpoint(), nil, Login{Access: jwt()}, "session", tc.opts.ClientIdentity)
				if err != nil {
					t.Fatal(err)
				}
				if got := req.Header.Get("Originator"); got != tc.want {
					t.Errorf("originator = %q, want %q", got, tc.want)
				}
			})
			t.Run("ChatGPT browser sign-in", func(t *testing.T) {
				c := oauthDefaults()
				c.listen = "127.0.0.1:0"
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				var address string
				_, err := c.signIn(ctx, Codex, false, nil, func(step Step) {
					address = step.Address
					cancel() // Inspect the address without opening it or exchanging a code.
				}, tc.opts)
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				u, err := url.Parse(address)
				if err != nil {
					t.Fatal(err)
				}
				if got := u.Query().Get("originator"); got != tc.want {
					t.Errorf("originator = %q, want %q", got, tc.want)
				}
			})
			t.Run("Grok device sign-in", func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if err := r.ParseForm(); err != nil {
						t.Error(err)
					}
					if got := r.PostForm.Get("referrer"); got != tc.want {
						t.Errorf("referrer = %q, want %q", got, tc.want)
					}
					w.WriteHeader(http.StatusBadRequest)
					io.WriteString(w, `{"error":"fixture stops sign-in before polling"}`)
				}))
				defer server.Close()
				c := oauthDefaults()
				c.client, c.xaiDevice = server.Client(), server.URL
				_, err := c.signIn(t.Context(), Xai, true, nil, func(step Step) {
					t.Errorf("unexpected sign-in prompt: %+v", step)
				}, tc.opts)
				if err == nil || !strings.Contains(err.Error(), "fixture stops sign-in before polling") {
					t.Fatalf("expected the fixture's error, got %v", err)
				}
			})
		})
	}
}
