package subscription

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"slices"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

const chatGPTEndpoint = "https://chatgpt.com/backend-api/codex/responses"

//go:embed subscription-models.json
var modelTable []byte

var levels = []string{"off", "minimal", "low", "medium", "high", "xhigh"}

type reasoningMapping struct{ Reasoning struct{ Effort string } }
type subscriptionModel struct {
	Info   modular.ModelInfo
	Levels map[string]reasoningMapping
}

func subscriptionModels(provider string) []subscriptionModel {
	var table struct {
		Models []struct {
			modular.ModelInfo
			Levels map[string]reasoningMapping
		}
	}
	if err := json.Unmarshal(modelTable, &table); err != nil {
		panic("invalid embedded subscription model table")
	}
	var out []subscriptionModel
	for _, m := range table.Models {
		if m.Provider != provider {
			continue
		}
		for _, level := range levels {
			if _, ok := m.Levels[level]; ok {
				m.Thinking = append(m.Thinking, level)
			}
		}
		out = append(out, subscriptionModel{Info: m.ModelInfo, Levels: m.Levels})
	}
	return out
}

func clientIdentity(identity *string) (string, error) {
	if identity == nil {
		return "modular-agent", nil
	}
	label := *identity
	invalid := errors.New("client identity must be 1 to 64 characters from A-Z, a-z, 0-9, ., _, and -")
	if len(label) < 1 || len(label) > 64 {
		return "", invalid
	}
	for _, c := range label {
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9', c == '.', c == '_', c == '-':
		default:
			return "", invalid
		}
	}
	return label, nil
}

// ChatGPTOptions configures the ChatGPT plan Provider. A nil ClientIdentity uses
// "modular-agent". Models enroll unlisted IDs without reasoning controls.
// HTTPTransport is optional and trusted with the login, including the refresh token.
type ChatGPTOptions struct {
	Logins         Logins
	ClientIdentity *string
	Models         []modular.ModelInfo
	HTTPTransport  http.RoundTripper
}

// ChatGPT constructs the chatgpt Provider. It reads the login file at request time.
func ChatGPT(opts ChatGPTOptions) (modular.Provider, error) {
	invalid := func(message string) (modular.Provider, error) {
		return modular.Provider{}, &modular.Error{Code: modular.InvalidComposition, Message: message}
	}
	identity, err := clientIdentity(opts.ClientIdentity)
	if err != nil {
		return invalid(err.Error())
	}
	if opts.Logins.path == "" {
		return invalid("ChatGPT requires a subscription login file")
	}
	models := subscriptionModels("chatgpt")
	for _, m := range opts.Models {
		if m.ID == "" || m.ContextWindow < 0 || m.MaxOutput < 0 || (m.Provider != "" && m.Provider != "chatgpt") {
			return invalid("invalid ChatGPT model")
		}
		if slices.ContainsFunc(models, func(existing subscriptionModel) bool { return existing.Info.ID == m.ID }) {
			return invalid("duplicate ChatGPT model: " + m.ID)
		}
		m.Provider, m.Thinking, m.Input = "chatgpt", nil, slices.Clone(m.Input)
		models = append(models, subscriptionModel{Info: m})
	}
	transport := opts.HTTPTransport
	oauth := oauthDefaults()
	if transport == nil {
		transport = &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext, ResponseHeaderTimeout: 300 * time.Second, IdleConnTimeout: 90 * time.Second, ForceAttemptHTTP2: true}
	} else {
		oauth.client.Transport = transport
	}
	client := &http.Client{Transport: transport, CheckRedirect: noRedirect}
	return modular.Provider{ID: "chatgpt", Models: func() []modular.ModelInfo {
		out := make([]modular.ModelInfo, 0, len(models))
		for _, model := range models {
			info := model.Info
			info.Input, info.Thinking = slices.Clone(info.Input), slices.Clone(info.Thinking)
			out = append(out, info)
		}
		return out
	}, Available: func() bool {
		login, err := opts.Logins.Login("chatgpt")
		return err == nil && login != nil && login.Type == "oauth"
	}, Request: func(ctx context.Context, ref modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
		failure := func(kind modular.ModelErrorKind, message string) (modular.AssistantMessage, error) {
			return modular.AssistantMessage{}, &modular.ModelError{Kind: kind, Message: message}
		}
		i := slices.IndexFunc(models, func(m subscriptionModel) bool { return m.Info.ID == ref.ID })
		if i < 0 || (ref.Provider != "" && ref.Provider != "chatgpt") {
			return modular.AssistantMessage{}, &modular.Error{Code: modular.InvalidRequest, Message: "unknown ChatGPT model"}
		}
		b, err := json.Marshal(requestBody(models[i], r))
		if err != nil {
			return modular.AssistantMessage{}, err
		}
		var rejected *Login
		for {
			login, err := opts.Logins.Current(ctx, "chatgpt", rejected, oauth.refresh)
			if err != nil {
				return failure(modular.Credentials, err.Error())
			}
			if login.Type != "oauth" {
				return failure(modular.Credentials, "no ChatGPT plan login; sign in again")
			}
			req, err := newResponsesRequest(ctx, chatGPTEndpoint, b, login, r.SessionID, identity)
			if err != nil {
				return modular.AssistantMessage{}, err
			}
			res, err := client.Do(req)
			if err != nil {
				if ctx.Err() != nil {
					return modular.AssistantMessage{}, ctx.Err()
				}
				return failure(modular.Temporary, "could not reach ChatGPT")
			}
			if ok(res.StatusCode) {
				defer res.Body.Close()
				return readStream(res.Body, pc)
			}
			if res.StatusCode == http.StatusUnauthorized && rejected == nil {
				res.Body.Close()
				rejected = &login
				continue
			}
			var body struct{ Error map[string]any }
			_ = json.NewDecoder(http.MaxBytesReader(nil, res.Body, 1<<20)).Decode(&body)
			res.Body.Close()
			return modular.AssistantMessage{}, modelError(res.StatusCode, body.Error)
		}
	}}, nil
}
