package subscription

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

const (
	grokID       = "grok"
	grokEndpoint = "https://api.x.ai/v1/responses"
	grokClient   = "b1a00492-073a-47ea-816f-4c329264a828"
	grokScope    = "openid profile email offline_access grok-cli:access api:access"
	grokDevice   = "https://auth.x.ai/oauth2/device/code"
	grokToken    = "https://auth.x.ai/oauth2/token"
)

// GrokOptions configures the Grok plan Provider. ClientIdentity is validated
// here but is sent only by SignIn, which takes its own ClientIdentity option.
// Models enroll unlisted IDs without reasoning controls. HTTPTransport is
// optional and trusted with the login, including the refresh token.
type GrokOptions struct {
	Logins           Logins
	ClientIdentity   *string
	Models           []modular.ModelInfo
	CatalogOverrides []ResponsesModelOverride
	HTTPTransport    http.RoundTripper
}

// Grok constructs the grok Provider. It reads the login file at request time.
func Grok(opts GrokOptions) (modular.Provider, error) {
	config := responsesConfig{id: grokID, label: "Grok", endpoint: grokEndpoint, systemMessage: true, legacyID: "xai"}
	return responsesProvider(config, opts.Logins, opts.ClientIdentity, opts.Models, opts.CatalogOverrides, opts.HTTPTransport)
}

func (c oauthClient) grokSignIn(ctx context.Context, show func(SignInStep), identity string) (Login, error) {
	status, body, err := c.post(ctx, grokDevice, url.Values{"client_id": {grokClient}, "scope": {grokScope}, "referrer": {identity}})
	if err != nil {
		return Login{}, err
	}
	if !ok(status) {
		return Login{}, fmt.Errorf("starting the Grok sign-in failed (HTTP %d)", status)
	}
	address := str(body, "verification_uri_complete")
	if address == "" {
		address = str(body, "verification_uri")
	}
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return Login{}, errors.New("the Grok sign-in gave an address that is not https")
	}
	code, device := str(body, "user_code"), str(body, "device_code")
	if code == "" || device == "" {
		return Login{}, errors.New("the Grok sign-in answer is incomplete")
	}
	deadline := time.Now().Add(time.Duration(number(body, "expires_in", 900)) * c.unit)
	show(SignInStep{Kind: DeviceCode, URL: address, Code: code})
	show(SignInStep{Kind: Waiting})
	interval := number(body, "interval", 5)
	if interval == 0 {
		interval = 5
	}
	var login Login
	err = c.poll(ctx, interval, time.Until(deadline), func(ctx context.Context) (bool, bool, error) {
		status, data, err := c.post(ctx, grokToken, url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "client_id": {grokClient}, "device_code": {device}})
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
		return false, false, fmt.Errorf("the Grok sign-in failed (HTTP %d)", status)
	})
	return login, err
}
