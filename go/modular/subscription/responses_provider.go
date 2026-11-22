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

// ResponsesModelOverride replaces a subscription catalog entry with the
// operator's model limits and exact vendor effort values.
type ResponsesModelOverride struct {
	Model  modular.ModelInfo
	Effort map[string]string
}

type responsesConfig struct {
	id, legacyID, label, endpoint string
	systemMessage                 bool
}

func responsesProvider(config responsesConfig, logins Logins, label *string, enrolled []modular.ModelInfo, overrides []ResponsesModelOverride, transport http.RoundTripper) (modular.Provider, error) {
	invalid := func(message string) (modular.Provider, error) {
		return modular.Provider{}, &modular.Error{Code: modular.InvalidComposition, Message: message}
	}
	identity, err := clientIdentity(label)
	if err != nil {
		return invalid(err.Error())
	}
	if logins.path == "" {
		return invalid(config.label + " requires a subscription login file")
	}
	models := subscriptionModels(config.id)
	for _, m := range enrolled {
		if m.ID == "" || m.ContextWindow < 0 || m.MaxOutput < 0 || (m.Provider != "" && m.Provider != config.id) {
			return invalid("invalid " + config.label + " model")
		}
		if slices.ContainsFunc(models, func(existing subscriptionModel) bool { return existing.Info.ID == m.ID }) {
			return invalid("duplicate " + config.label + " model: " + m.ID)
		}
		m.Provider, m.Thinking, m.Input = config.id, nil, slices.Clone(m.Input)
		models = append(models, subscriptionModel{Info: m})
	}
	for _, override := range overrides {
		info := override.Model
		if info.ID == "" || info.ContextWindow <= 0 || info.MaxOutput <= 0 {
			return invalid("invalid " + config.label + " model override")
		}
		info.Provider, info.Thinking, info.Input = config.id, nil, slices.Clone(info.Input)
		mapping := map[string]reasoningMapping{}
		for _, level := range levels {
			if effort, ok := override.Effort[level]; ok {
				entry := reasoningMapping{}
				entry.Reasoning.Effort = effort
				mapping[level] = entry
				info.Thinking = append(info.Thinking, level)
				info.Reasoning = info.Reasoning || level != "off"
			}
		}
		models = slices.DeleteFunc(models, func(m subscriptionModel) bool { return m.Info.ID == info.ID })
		models = append(models, subscriptionModel{Info: info, Levels: mapping})
	}
	oauth := oauthDefaults()
	defaultTransport := transport == nil
	if defaultTransport {
		transport = &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ResponseHeaderTimeout: 300 * time.Second,
			IdleConnTimeout:       90 * time.Second,
			ForceAttemptHTTP2:     true,
			DisableCompression:    config.systemMessage,
		}
	} else {
		oauth.client.Transport = transport
	}
	client := &http.Client{Transport: transport, CheckRedirect: noRedirect}
	refresh := func(ctx context.Context, old Login) (Login, error) {
		return oauth.refresh(ctx, config.id, old)
	}
	return modular.Provider{ID: config.id, Models: func() []modular.ModelInfo {
		out := make([]modular.ModelInfo, 0, len(models))
		for _, model := range models {
			info := model.Info
			info.Input, info.Thinking = slices.Clone(info.Input), slices.Clone(info.Thinking)
			out = append(out, info)
		}
		return out
	}, Available: func() bool {
		login, err := logins.Login(config.id)
		return err == nil && login != nil && (config.systemMessage || login.Type == "oauth")
	}, Request: func(ctx context.Context, ref modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
		failure := func(kind modular.ModelErrorKind, message string) (modular.AssistantMessage, error) {
			return modular.AssistantMessage{}, &modular.ModelError{Kind: kind, Message: message}
		}
		i := slices.IndexFunc(models, func(m subscriptionModel) bool { return m.Info.ID == ref.ID })
		if i < 0 || (ref.Provider != "" && ref.Provider != config.id) {
			return modular.AssistantMessage{}, &modular.Error{Code: modular.InvalidRequest, Message: "unknown " + config.label + " model"}
		}
		b, err := json.Marshal(config.requestBody(models[i], r))
		if err != nil {
			return modular.AssistantMessage{}, err
		}
		var rejected *Login
		for {
			login, err := logins.Current(ctx, config.id, rejected, refresh)
			if err != nil {
				return failure(modular.Credentials, err.Error())
			}
			if !config.systemMessage && login.Type != "oauth" {
				return failure(modular.Credentials, "no "+config.label+" plan login; sign in again")
			}
			req, err := config.newRequest(ctx, b, login, r.SessionID, identity)
			if err != nil {
				return modular.AssistantMessage{}, err
			}
			if config.systemMessage && defaultTransport {
				// Suppress net/http's default User-Agent on the wire.
				req.Header["User-Agent"] = nil
			}
			res, err := client.Do(req)
			if err != nil {
				if ctx.Err() != nil {
					return modular.AssistantMessage{}, ctx.Err()
				}
				return failure(modular.Temporary, "could not reach "+config.label)
			}
			if ok(res.StatusCode) {
				defer res.Body.Close()
				return config.readStream(res.Body, pc)
			}
			if res.StatusCode == http.StatusUnauthorized && rejected == nil && login.Type == "oauth" {
				res.Body.Close()
				rejected = &login
				continue
			}
			var body map[string]any
			_ = json.NewDecoder(http.MaxBytesReader(nil, res.Body, 1<<20)).Decode(&body)
			res.Body.Close()
			if nested := decodeField(body, "error"); nested != nil || !config.systemMessage {
				body = nested
			}
			return modular.AssistantMessage{}, config.modelError(res.StatusCode, body)
		}
	}}, nil
}
