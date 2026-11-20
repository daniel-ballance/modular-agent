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
)

// Pi's value is a placeholder until the services accept this client's own name.
const CLIENT_IDENTITY = "pi"

const (
	codexClient         = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexScope          = "openid profile email offline_access"
	codexDeviceRedirect = "https://auth.openai.com/deviceauth/callback"
	xaiClient           = "b1a00492-073a-47ea-816f-4c329264a828"
	xaiScope            = "openid profile email offline_access grok-cli:access api:access"
)

type Vendor string

const (
	Codex Vendor = "openai-codex"
	Xai   Vendor = "xai"
)

func (v Vendor) Label() string {
	if v == Codex {
		return "ChatGPT subscription"
	}
	return "Grok subscription"
}

type Step struct {
	Address, Code, Note string
	OpenAndPaste        bool
}
type oauthClient struct {
	client                                                                                          *http.Client
	authorize, redirect, listen, codexToken, codexDevice, codexPoll, codexPage, xaiToken, xaiDevice string
	unit, wait                                                                                      time.Duration
}

func oauthDefaults() oauthClient {
	return oauthClient{client: &http.Client{Timeout: 30 * time.Second, CheckRedirect: noRedirect}, authorize: "https://auth.openai.com/oauth/authorize", redirect: "http://localhost:1455/auth/callback", listen: "127.0.0.1:1455", codexToken: "https://auth.openai.com/oauth/token", codexDevice: "https://auth.openai.com/api/accounts/deviceauth/usercode", codexPoll: "https://auth.openai.com/api/accounts/deviceauth/token", codexPage: "https://auth.openai.com/codex/device", xaiToken: "https://auth.x.ai/oauth2/token", xaiDevice: "https://auth.x.ai/oauth2/device/code", unit: time.Second, wait: 15 * time.Minute}
}
func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
func SignIn(ctx context.Context, v Vendor, device bool, pasted <-chan string, show func(Step)) (Login, error) {
	return oauthDefaults().signIn(ctx, v, device, pasted, show)
}
func (c oauthClient) signIn(ctx context.Context, v Vendor, device bool, pasted <-chan string, show func(Step)) (Login, error) {
	if v == Xai {
		return c.xaiSignIn(ctx, show)
	}
	if !device {
		listener, err := net.Listen("tcp4", c.listen)
		if err == nil {
			return c.browser(ctx, listener, pasted, show)
		}
		if !errors.Is(err, syscall.EADDRINUSE) {
			return Login{}, err
		}
		if pasted != nil {
			show(Step{Note: "Port 1455 is in use, so paste the address the browser comes back to."})
			return c.browser(ctx, nil, pasted, show)
		}
		show(Step{Note: "Port 1455 is in use, so the browser sign-in cannot return here. Using a code instead."})
	}
	return c.codexSignIn(ctx, show)
}
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
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return res.StatusCode, nil, err
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
func oauthError(action string, status int, body map[string]any) error {
	// Never show an arbitrary successful or non-JSON body: it may contain tokens.
	detail := str(body, "error")
	if desc := str(body, "error_description"); desc != "" {
		if detail != "" {
			detail += ": "
		}
		detail += desc
	}
	if detail != "" {
		detail = ": " + detail
	}
	return fmt.Errorf("%s failed (HTTP %d)%s", action, status, detail)
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
func tokens(v Vendor, body map[string]any, previous string) (Login, error) {
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
	l := Login{Type: "oauth", Access: access, Refresh: refresh, Expires: uint64(time.Now().UnixMilli() + int64(number(body, "expires_in", 3600))*1000 - 300000)}
	if v == Codex {
		a, err := account(access)
		if err != nil {
			return Login{}, err
		}
		l.Account = &a
	}
	return l, nil
}
func (c oauthClient) refresh(ctx context.Context, v Vendor, l Login) (Login, error) {
	if l.Type != "oauth" {
		return l, nil
	}
	endpoint, id := c.codexToken, codexClient
	if v == Xai {
		endpoint, id = c.xaiToken, xaiClient
	}
	status, body, err := c.post(ctx, endpoint, url.Values{"grant_type": {"refresh_token"}, "client_id": {id}, "refresh_token": {l.Refresh}})
	if err != nil {
		return Login{}, fmt.Errorf("could not reach %s to refresh the sign-in: %w", v.Label(), err)
	}
	if !ok(status) {
		return Login{}, oauthError(fmt.Sprintf("refreshing the %s sign-in (run `ma login %s`)", v.Label(), v), status, body)
	}
	return tokens(v, body, l.Refresh)
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
func (c oauthClient) xaiSignIn(ctx context.Context, show func(Step)) (Login, error) {
	status, body, err := c.post(ctx, c.xaiDevice, url.Values{"client_id": {xaiClient}, "scope": {xaiScope}, "referrer": {CLIENT_IDENTITY}})
	if err != nil {
		return Login{}, err
	}
	if !ok(status) {
		return Login{}, oauthError("starting the Grok sign-in", status, body)
	}
	address := str(body, "verification_uri_complete")
	if address == "" {
		address = str(body, "verification_uri")
	}
	code, id := str(body, "user_code"), str(body, "device_code")
	if !strings.HasPrefix(address, "https://") {
		return Login{}, errors.New("the Grok sign-in gave an address that is not https")
	}
	if code == "" || id == "" {
		return Login{}, errors.New("the Grok sign-in answer is incomplete")
	}
	show(Step{Address: address, Code: code})
	var login Login
	interval := number(body, "interval", 5)
	if interval == 0 {
		interval = 5
	}
	err = c.poll(ctx, interval, time.Duration(number(body, "expires_in", 900))*c.unit, func(ctx context.Context) (bool, bool, error) {
		status, data, err := c.post(ctx, c.xaiToken, url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "client_id": {xaiClient}, "device_code": {id}})
		if err != nil {
			return false, false, err
		}
		if ok(status) {
			login, err = tokens(Xai, data, "")
			return true, false, err
		}
		switch str(data, "error") {
		case "authorization_pending":
			return false, false, nil
		case "slow_down":
			return false, true, nil
		case "access_denied", "authorization_denied":
			return false, false, errors.New("the Grok sign-in was denied")
		case "expired_token":
			return false, false, errors.New("the Grok sign-in code expired")
		}
		return false, false, oauthError("the Grok sign-in", status, data)
	})
	return login, err
}
func (c oauthClient) exchange(ctx context.Context, code, verifier, redirect string) (Login, error) {
	status, body, err := c.post(ctx, c.codexToken, url.Values{"grant_type": {"authorization_code"}, "client_id": {codexClient}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {redirect}})
	if err != nil {
		return Login{}, err
	}
	if !ok(status) {
		return Login{}, oauthError("the ChatGPT sign-in", status, body)
	}
	return tokens(Codex, body, "")
}
func (c oauthClient) codexSignIn(ctx context.Context, show func(Step)) (Login, error) {
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
	show(Step{Address: c.codexPage, Code: code})
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
	if address || strings.Contains(input, "code=") {
		if address {
			query, _, _ = strings.Cut(query, "#")
			if reason, ok := pastedParam(query, "error"); ok {
				if desc, ok := pastedParam(query, "error_description"); ok {
					reason = desc
				}
				return "", fmt.Errorf("the sign-in was not completed: %s", reason)
			}
		} else {
			query = input
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

func (c oauthClient) browser(ctx context.Context, l net.Listener, pasted <-chan string, show func(Step)) (Login, error) {
	verifier := base64.RawURLEncoding.EncodeToString(randBytes(32))
	state := base64.RawURLEncoding.EncodeToString(randBytes(16))
	challenge := sha256.Sum256([]byte(verifier))
	values := url.Values{"response_type": {"code"}, "client_id": {codexClient}, "redirect_uri": {c.redirect}, "scope": {codexScope}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "state": {state}, "id_token_add_organizations": {"true"}, "codex_cli_simplified_flow": {"true"}, "originator": {CLIENT_IDENTITY}}
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
			if code == "" {
				reason := q.Get("error_description")
				if reason == "" {
					reason = q.Get("error")
				}
				if reason == "" {
					reason = "no code returned"
				}
				err = fmt.Errorf("the sign-in was not completed: %s", reason)
				http.Error(w, "The sign-in did not complete. Return to the terminal.", 400)
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
	show(Step{Address: c.authorize + "?" + values.Encode(), OpenAndPaste: pasted != nil})
	timer := time.NewTimer(c.wait)
	defer timer.Stop()
	for {
		select {
		case r := <-result:
			if r.err != nil {
				return Login{}, r.err
			}
			return c.exchange(ctx, r.code, verifier, c.redirect)
		case line, open := <-pasted:
			if !open {
				pasted = nil // The terminal closed; keep waiting for the browser.
				continue
			}
			code, err := pastedCode(line, state)
			if err != nil {
				show(Step{Note: err.Error() + ". Paste it again."})
			} else if code != "" {
				return c.exchange(ctx, code, verifier, c.redirect)
			}
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
