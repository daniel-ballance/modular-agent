package grok

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	ID        = "grok"
	Label     = "Grok subscription"
	xaiClient = "b1a00492-073a-47ea-816f-4c329264a828"
	xaiScope  = "openid profile email offline_access grok-cli:access api:access"
)

type Step struct{ Address, Code string }

type oauthClient struct {
	client              *http.Client
	xaiToken, xaiDevice string
	unit                time.Duration
}

func oauthDefaults() oauthClient {
	return oauthClient{client: &http.Client{Timeout: 30 * time.Second, CheckRedirect: noRedirect}, xaiToken: "https://auth.x.ai/oauth2/token", xaiDevice: "https://auth.x.ai/oauth2/device/code", unit: time.Second}
}
func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
func SignIn(ctx context.Context, show func(Step), identity ClientIdentity) (subscription.Login, error) {
	return oauthDefaults().signIn(ctx, show, identity)
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
func tokens(body map[string]any, previous string) (subscription.Login, error) {
	access, refresh := str(body, "access_token"), str(body, "refresh_token")
	if access == "" {
		return subscription.Login{}, errors.New("the sign-in answer has no access token")
	}
	if refresh == "" {
		refresh = previous
	}
	if refresh == "" {
		return subscription.Login{}, errors.New("the sign-in answer has no refresh token")
	}
	l := subscription.Login{Type: "oauth", Access: access, Refresh: refresh, Expires: uint64(time.Now().UnixMilli() + int64(number(body, "expires_in", 3600))*1000 - 300000)}
	return l, nil
}
func (c oauthClient) refresh(ctx context.Context, l subscription.Login) (subscription.Login, error) {
	if l.Type != "oauth" {
		return l, nil
	}
	status, body, err := c.post(ctx, c.xaiToken, url.Values{"grant_type": {"refresh_token"}, "client_id": {xaiClient}, "refresh_token": {l.Refresh}})
	if err != nil {
		return subscription.Login{}, fmt.Errorf("could not reach %s to refresh the sign-in: %w", Label, err)
	}
	if !ok(status) {
		return subscription.Login{}, oauthError(fmt.Sprintf("refreshing the %s sign-in (run `ma login %s`)", Label, ID), status, body)
	}
	return tokens(body, l.Refresh)
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
func (c oauthClient) signIn(ctx context.Context, show func(Step), identity ClientIdentity) (subscription.Login, error) {
	status, body, err := c.post(ctx, c.xaiDevice, url.Values{"client_id": {xaiClient}, "scope": {xaiScope}, "referrer": {identity.name()}})
	if err != nil {
		return subscription.Login{}, err
	}
	if !ok(status) {
		return subscription.Login{}, oauthError("starting the Grok sign-in", status, body)
	}
	address := str(body, "verification_uri_complete")
	if address == "" {
		address = str(body, "verification_uri")
	}
	code, id := str(body, "user_code"), str(body, "device_code")
	if !strings.HasPrefix(address, "https://") {
		return subscription.Login{}, errors.New("the Grok sign-in gave an address that is not https")
	}
	if code == "" || id == "" {
		return subscription.Login{}, errors.New("the Grok sign-in answer is incomplete")
	}
	show(Step{Address: address, Code: code})
	var login subscription.Login
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
			login, err = tokens(data, "")
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
