package modular

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

type ModelInfo struct {
	ModelRef
	ContextWindow int      `json:"contextWindow"`
	MaxOutput     int      `json:"maxOutput"`
	Input         []string `json:"input"`
	Reasoning     bool     `json:"reasoning"`
}
type ModelErrorKind string

const (
	Temporary       ModelErrorKind = "temporary"
	ContextTooLarge ModelErrorKind = "contextTooLarge"
	Credentials     ModelErrorKind = "credentials"
	ModelRefused    ModelErrorKind = "refused"
	Other           ModelErrorKind = "other"
)

type ModelError struct {
	Kind    ModelErrorKind `json:"kind"`
	Message string         `json:"message"`
}

func (e *ModelError) Error() string { return e.Message }

type ModelRequest struct {
	SystemPrompt string           `json:"systemPrompt"`
	Messages     []Message        `json:"messages"`
	Tools        []ToolDefinition `json:"tools"`
	Settings     Settings         `json:"settings"`
}
type Message struct {
	Role       string  `json:"role"`
	Content    Content `json:"content"`
	Stop       string  `json:"stop,omitempty"`
	ToolCallID string  `json:"toolCallId,omitempty"`
	ToolName   string  `json:"toolName,omitempty"`
	IsError    bool    `json:"isError,omitempty"`
}
type AssistantMessage struct {
	Role    string      `json:"role"`
	Content Content     `json:"content"`
	Stop    string      `json:"stop"`
	Usage   Usage       `json:"usage"`
	Error   *ModelError `json:"error,omitempty"`
}
type ProviderContext struct {
	piece      func(Part)
	credential func() (string, error)
}

func (c *ProviderContext) Piece(kind, delta string, toolCallID ...string) {
	p := Part{Type: kind, Text: delta}
	if len(toolCallID) > 0 {
		b, _ := json.Marshal(toolCallID[0])
		p.Fields = map[string]json.RawMessage{"toolCallId": b}
	}
	c.piece(p)
}
func (c *ProviderContext) Credential() (string, error) {
	if c.credential == nil {
		return "", &Error{Code: NotFound, Message: "provider credential unavailable"}
	}
	return c.credential()
}

type ProviderSupport struct{ KeepsState, SafeToRepeat bool }
type Provider struct {
	ID           string
	Models       func() []ModelInfo
	Supports     ProviderSupport
	Available    func() bool
	Request      func(context.Context, ModelRef, ModelRequest, *ProviderContext) (AssistantMessage, error)
	DiscardState func(context.Context, string) error
}
type providerAdapter struct{ p Provider }

func (p providerAdapter) Catalog() []api.Model {
	var out []api.Model
	for _, m := range p.p.Models() {
		m.Provider = p.p.ID
		var o portable.Object
		_ = decodeInto(m, &o)
		b := portable.ReadModel(o)
		b.Stateful = p.p.Supports.KeepsState
		b.SafeToRepeatRequests = p.p.Supports.SafeToRepeat
		out = append(out, b)
	}
	return out
}
func (p providerAdapter) Access(id string) (api.ModelAccess, error) {
	for _, m := range p.Catalog() {
		if m.ID == id || strings.TrimPrefix(m.ID, p.p.ID+"/") == id {
			return modelAccess{p.p, m}, nil
		}
	}
	return nil, &Error{Code: InvalidRequest, Message: "unknown model " + id}
}
func (p providerAdapter) Discard(ctx context.Context, session string) error {
	if p.p.DiscardState == nil {
		return nil
	}
	return p.p.DiscardState(ctx, session)
}

type modelAccess struct {
	p     Provider
	model api.Model
}

func (m modelAccess) Model() api.Model { return m.model }
func (m modelAccess) Generate(ctx context.Context, r api.Request, emit func(api.Part)) (api.Response, error) {
	var request ModelRequest
	if err := decodeInto(portable.Request(r), &request); err != nil {
		return api.Response{}, err
	}
	ref := ModelRef{Provider: m.model.Provider, ID: strings.TrimPrefix(m.model.ID, m.model.Provider+"/")}
	pc := &ProviderContext{credential: func() (string, error) {
		if err := ctx.Err(); err != nil {
			return "", appError(err, CancelledCode)
		}
		key, err := (environmentCredentials{}).Get(ctx, ref.Provider)
		if err != nil {
			return "", err
		}
		if key == "" {
			return "", &Error{Code: NotFound, Message: "provider credential unavailable"}
		}
		return key, nil
	}, piece: func(p Part) {
		if ctx.Err() == nil {
			if c := portable.ReadContent(Content{p}); len(c) > 0 {
				emit(c[0])
			}
		}
	}}
	response, err := m.p.Request(ctx, ref, request, pc)
	if err != nil {
		var modelError *ModelError
		if !errors.As(err, &modelError) {
			return api.Response{}, err
		}
		response = AssistantMessage{Stop: "failed", Error: modelError}
	}
	response.Role = "assistant"
	if response.Content == nil {
		response.Content = Content{}
	}
	var o portable.Object
	if err := decodeInto(response, &o); err != nil {
		return api.Response{}, err
	}
	return portable.ReadResponse(o), nil
}
func (a *Agent) Models() []ModelInfo {
	var result []ModelInfo
	for _, p := range a.a.All("provider.") {
		for _, m := range p.(api.Provider).Catalog() {
			var info ModelInfo
			if decodeInto(portable.Model(m), &info) == nil {
				result = append(result, info)
			}
		}
	}
	return result
}
