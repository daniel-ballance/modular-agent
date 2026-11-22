package subscription

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

const (
	codexClient         = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexScope          = "openid profile email offline_access"
	codexDeviceRedirect = "https://auth.openai.com/deviceauth/callback"
)

// SignInStepKind is an instruction reported by SignIn.
type SignInStepKind string

const (
	OpenAndPaste SignInStepKind = "openAndPaste"
	DeviceCode   SignInStepKind = "deviceCode"
	Waiting      SignInStepKind = "waiting"
)

// SignInStep tells the caller what to show. A retry can carry a Note without a URL.
type SignInStep struct {
	Kind            SignInStepKind
	URL, Code, Note string
	CanPaste        bool
}

// SignInOptions lets the caller show progress and supply pasted input.
// Paste must return when its context is cancelled. SignIn never opens a browser.
type SignInOptions struct {
	Device         bool
	Paste          func(context.Context) (string, error)
	OnStep         func(SignInStep)
	ClientIdentity *string
	HTTPTransport  http.RoundTripper
}

// SignIn signs in to ChatGPT or Grok and stores the resulting login.
func SignIn(ctx context.Context, provider string, logins Logins, opts SignInOptions) error {
	return oauthDefaults().signIn(ctx, provider, logins, opts)
}

func (c oauthClient) signIn(ctx context.Context, provider string, logins Logins, opts SignInOptions) error {
	invalid := func(message string) error { return &modular.Error{Code: modular.InvalidParams, Message: message} }
	if provider != "chatgpt" && provider != grokID {
		return invalid("subscription sign-in supports chatgpt and grok only")
	}
	identity, err := clientIdentity(opts.ClientIdentity)
	if err != nil {
		return invalid(err.Error())
	}
	if opts.HTTPTransport != nil {
		c.client.Transport = opts.HTTPTransport
	}
	show := opts.OnStep
	if show == nil {
		show = func(SignInStep) {}
	}
	var login Login
	switch {
	case provider == grokID:
		login, err = c.grokSignIn(ctx, show, identity)
	case opts.Device:
		login, err = c.codexSignIn(ctx, show)
	default:
		var listener net.Listener
		listener, err = net.Listen("tcp4", c.listen)
		switch {
		case err == nil:
			login, err = c.browser(ctx, listener, opts.Paste, show, identity)
		case !errors.Is(err, syscall.EADDRINUSE):
			return err
		case opts.Paste != nil:
			show(SignInStep{Kind: OpenAndPaste, CanPaste: true, Note: "Port 1455 is in use, so paste the address the browser comes back to."})
			login, err = c.browser(ctx, nil, opts.Paste, show, identity)
		default:
			show(SignInStep{Kind: DeviceCode, Note: "Port 1455 is in use, so the browser sign-in cannot return here. Using a code instead."})
			login, err = c.codexSignIn(ctx, show)
		}
	}
	if err != nil {
		return err
	}
	return logins.Set(ctx, provider, &login)
}

// SignOut removes a ChatGPT or Grok login without contacting the service.
func SignOut(ctx context.Context, provider string, logins Logins) error {
	if provider != "chatgpt" && provider != grokID {
		return &modular.Error{Code: modular.InvalidParams, Message: "subscription sign-out supports chatgpt and grok only"}
	}
	return logins.Set(ctx, provider, nil)
}

type oauthClient struct {
	client                                                                     *http.Client
	authorize, redirect, listen, codexToken, codexDevice, codexPoll, codexPage string
	unit, wait                                                                 time.Duration
}

func oauthDefaults() oauthClient {
	return oauthClient{client: &http.Client{Timeout: 30 * time.Second, CheckRedirect: noRedirect}, authorize: "https://auth.openai.com/oauth/authorize", redirect: "http://localhost:1455/auth/callback", listen: "127.0.0.1:1455", codexToken: "https://auth.openai.com/oauth/token", codexDevice: "https://auth.openai.com/api/accounts/deviceauth/usercode", codexPoll: "https://auth.openai.com/api/accounts/deviceauth/token", codexPage: "https://auth.openai.com/codex/device", unit: time.Second, wait: 15 * time.Minute}
}
func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
func (c oauthClient) post(ctx context.Context, target string, body any) (int, map[string]any, error) {
	var content, kind string
	switch v := body.(type) {
	case url.Values:
		content, kind = v.Encode(), "application/x-www-form-urlencoded"
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return 0, nil, err
		}
		content, kind = string(b), "application/json"
	}
	req, err := http.NewRequestWithContext(ctx, "POST", target, strings.NewReader(content))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", kind)
	req.Header.Set("Accept", "application/json")
	res, err := c.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, nil, ctx.Err()
		}
		return 0, nil, errors.New("could not reach the sign-in endpoint")
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return res.StatusCode, nil, errors.New("could not read the sign-in reply")
	}
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return res.StatusCode, out, nil
}
func ok(status int) bool                      { return status >= 200 && status < 300 }
func str(v map[string]any, key string) string { s, _ := v[key].(string); return s }
func number(v map[string]any, key string, fallback int) int {
	switch n := v[key].(type) {
	case float64:
		if n >= 0 && n < 1<<31 {
			return int(n)
		}
	case string:
		if i, e := strconv.Atoi(strings.TrimSpace(n)); e == nil && i >= 0 && i < 1<<31 {
			return i
		}
	}
	return fallback
}
func account(access string) (string, error) {
	parts := strings.Split(access, ".")
	if len(parts) < 2 {
		return "", errors.New("the ChatGPT token is not in the expected form")
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return "", errors.New("the ChatGPT token is not in the expected form")
	}
	var claims map[string]json.RawMessage
	if json.Unmarshal(b, &claims) != nil {
		return "", errors.New("the ChatGPT token is not in the expected form")
	}
	var auth struct {
		Account string `json:"chatgpt_account_id"`
	}
	if json.Unmarshal(claims["https://api.openai.com/auth"], &auth) != nil || auth.Account == "" {
		return "", errors.New("the ChatGPT token names no account; sign in again")
	}
	return auth.Account, nil
}
func tokens(body map[string]any, previous string) (Login, error) {
	access, refresh := str(body, "access_token"), str(body, "refresh_token")
	if access == "" {
		return Login{}, errors.New("the sign-in answer has no access token")
	}
	if refresh == "" {
		refresh = previous
	}
	if refresh == "" {
		return Login{}, errors.New("the sign-in answer has no refresh token")
	}
	return Login{Type: "oauth", Access: access, Refresh: refresh, Expires: uint64(time.Now().UnixMilli() + int64(number(body, "expires_in", 3600))*1000 - 300000)}, nil
}

func codexTokens(body map[string]any, previous string) (Login, error) {
	l, err := tokens(body, previous)
	if err != nil {
		return Login{}, err
	}
	a, err := account(l.Access)
	if err != nil {
		return Login{}, err
	}
	l.Account = &a
	return l, nil
}
func (c oauthClient) refresh(ctx context.Context, provider string, l Login) (Login, error) {
	label, endpoint, client, parse := "ChatGPT", c.codexToken, codexClient, codexTokens
	if provider == grokID {
		label, endpoint, client, parse = "Grok", grokToken, grokClient, tokens
	}
	status, body, err := c.post(ctx, endpoint, url.Values{"grant_type": {"refresh_token"}, "client_id": {client}, "refresh_token": {l.Refresh}})
	if err != nil {
		return Login{}, fmt.Errorf("could not reach %s to refresh the sign-in", label)
	}
	if !ok(status) {
		if str(body, "error") == "invalid_grant" || status == 401 || status == 403 {
			return Login{}, fmt.Errorf("%s refused the refresh; sign in again", label)
		}
		return Login{}, fmt.Errorf("refreshing the %s sign-in failed (HTTP %d)", label, status)
	}
	return parse(body, l.Refresh)
}

func (c oauthClient) poll(ctx context.Context, interval int, limit time.Duration, attempt func(context.Context) (bool, bool, error)) error {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return errors.New("the sign-in was not completed in time")
			}
			return ctx.Err()
		case <-time.After(time.Duration(interval) * c.unit):
			// If both timers fired, expiry wins over starting another poll.
			if ctx.Err() != nil {
				continue
			}
		}
		done, slow, err := attempt(ctx)
		if done || err != nil {
			return err
		}
		if slow {
			interval += 5
		}
	}
}
func (c oauthClient) exchange(ctx context.Context, code, verifier, redirect string) (Login, error) {
	status, body, err := c.post(ctx, c.codexToken, url.Values{"grant_type": {"authorization_code"}, "client_id": {codexClient}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {redirect}})
	if err != nil {
		return Login{}, err
	}
	if !ok(status) {
		return Login{}, fmt.Errorf("the ChatGPT sign-in failed (HTTP %d)", status)
	}
	return codexTokens(body, "")
}
func (c oauthClient) codexSignIn(ctx context.Context, show func(SignInStep)) (Login, error) {
	status, body, err := c.post(ctx, c.codexDevice, map[string]string{"client_id": codexClient})
	if err != nil {
		return Login{}, err
	}
	if !ok(status) {
		return Login{}, fmt.Errorf("ChatGPT device sign-in is not available (HTTP %d); use the browser sign-in", status)
	}
	device, code := str(body, "device_auth_id"), str(body, "user_code")
	if device == "" || code == "" {
		return Login{}, errors.New("the ChatGPT sign-in answer is incomplete")
	}
	show(SignInStep{Kind: DeviceCode, URL: c.codexPage, Code: code})
	show(SignInStep{Kind: Waiting})
	var auth, verifier string
	err = c.poll(ctx, max(1, number(body, "interval", 5)), c.wait, func(ctx context.Context) (bool, bool, error) {
		status, data, err := c.post(ctx, c.codexPoll, map[string]string{"device_auth_id": device, "user_code": code})
		if err != nil {
			return false, false, err
		}
		if ok(status) {
			auth, verifier = str(data, "authorization_code"), str(data, "code_verifier")
			if auth == "" || verifier == "" {
				return false, false, errors.New("the ChatGPT sign-in answer is incomplete")
			}
			return true, false, nil
		}
		tag := str(data, "error")
		if inner, ok := data["error"].(map[string]any); ok {
			tag = str(inner, "code")
		}
		switch {
		case status == 403 || status == 404 || tag == "deviceauth_authorization_pending":
			return false, false, nil
		case tag == "slow_down":
			return false, true, nil
		}
		return false, false, fmt.Errorf("the ChatGPT sign-in failed (HTTP %d)", status)
	})
	if err != nil {
		return Login{}, err
	}
	return c.exchange(ctx, auth, verifier, codexDeviceRedirect)
}

// pastedCode reads a redirect address, its query, code#state or a bare code.
// A blank line returns no code; any state supplied must match this sign-in.
func pastedCode(line, state string) (string, error) {
	input := strings.TrimSpace(line)
	if input == "" {
		return "", nil
	}
	code, found, hasState := input, "", false
	_, query, address := strings.Cut(input, "?")
	if queryOnly := strings.Contains(input, "code=") || strings.Contains(input, "error=") || strings.Contains(input, "state="); address || queryOnly {
		if address {
			query, _, _ = strings.Cut(query, "#")
		} else {
			query = input
		}
		if _, present := pastedParam(query, "error"); present {
			return "", errors.New("the sign-in was not completed")
		}
		code, _ = pastedParam(query, "code")
		found, hasState = pastedParam(query, "state")
	} else {
		code, found, hasState = strings.Cut(input, "#")
	}
	if hasState && found != state {
		return "", errors.New("that address is from a different sign-in; paste the one from this sign-in")
	}
	if code == "" {
		return "", errors.New("no code found in what was pasted")
	}
	return code, nil
}

func pastedParam(query, name string) (string, bool) {
	for pair := range strings.SplitSeq(query, "&") {
		key, value, ok := strings.Cut(pair, "=")
		if ok && key == name {
			if decoded, err := url.QueryUnescape(value); err == nil {
				value = decoded
			}
			return value, true
		}
	}
	return "", false
}

func (c oauthClient) browser(ctx context.Context, l net.Listener, paste func(context.Context) (string, error), show func(SignInStep), identity string) (Login, error) {
	verifier := base64.RawURLEncoding.EncodeToString(randBytes(32))
	state := base64.RawURLEncoding.EncodeToString(randBytes(16))
	challenge := sha256.Sum256([]byte(verifier))
	values := url.Values{"response_type": {"code"}, "client_id": {codexClient}, "redirect_uri": {c.redirect}, "scope": {codexScope}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "state": {state}, "id_token_add_organizations": {"true"}, "codex_cli_simplified_flow": {"true"}, "originator": {identity}}
	type callback struct {
		code string
		err  error
	}
	var result chan callback
	var errCh chan error
	if l != nil {
		defer l.Close()
		result = make(chan callback, 1)
		errCh = make(chan error, 1)
		server := &http.Server{ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, MaxHeaderBytes: 8192, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "GET" || r.URL.Path != "/auth/callback" {
				http.NotFound(w, r)
				return
			}
			q := r.URL.Query()
			if subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(state)) != 1 {
				http.Error(w, "The sign-in did not complete. Return to the terminal.", 400)
				return
			}
			code := q.Get("code")
			var err error
			if q.Has("error") || code == "" {
				http.Error(w, "The sign-in did not complete. Return to the terminal.", 400)
				if paste != nil {
					return
				} // A failed browser return must not end a pending paste.
				err = errors.New("the sign-in was not completed")
			} else {
				fmt.Fprint(w, "Signed in. You can close this tab and return to the terminal.")
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			select {
			case result <- callback{code, err}:
			default:
			}
		})}
		defer server.Close()
		go func() { errCh <- server.Serve(l) }()
	}
	show(SignInStep{Kind: OpenAndPaste, URL: c.authorize + "?" + values.Encode(), CanPaste: paste != nil})
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	timer := time.NewTimer(c.wait)
	defer timer.Stop()
	type pasteResult struct {
		line string
		err  error
	}
	var pasted <-chan pasteResult
	readPaste := func() {
		if paste == nil {
			return
		}
		next := make(chan pasteResult, 1)
		pasted = next
		go func() { line, err := paste(ctx); next <- pasteResult{line, err} }()
	}
	readPaste()
	for {
		select {
		case r := <-result:
			if r.err != nil {
				return Login{}, r.err
			}
			return c.exchange(ctx, r.code, verifier, c.redirect)
		case p := <-pasted:
			if p.err != nil {
				pasted = nil
				if l == nil {
					return Login{}, errors.New("could not read the pasted sign-in code")
				}
				continue
			}
			code, err := pastedCode(p.line, state)
			if err != nil {
				show(SignInStep{Kind: OpenAndPaste, CanPaste: true, Note: err.Error() + ". Paste it again."})
			} else if code != "" {
				return c.exchange(ctx, code, verifier, c.redirect)
			}
			readPaste()
		case err := <-errCh:
			return Login{}, err
		case <-ctx.Done():
			return Login{}, ctx.Err()
		case <-timer.C:
			return Login{}, errors.New("the sign-in was not completed in time")
		}
	}
}
func randBytes(n int) []byte { b := make([]byte, n); _, _ = rand.Read(b); return b }
