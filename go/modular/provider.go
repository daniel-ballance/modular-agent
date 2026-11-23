package modular

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type ModelInfo struct {
	ModelRef
	ContextWindow int      `json:"contextWindow"`
	MaxOutput     int      `json:"maxOutput"`
	Input         []string `json:"input"`
	Reasoning     bool     `json:"reasoning"`
	Thinking      []string `json:"thinking,omitempty"`
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
	SessionID    string           `json:"sessionId,omitempty"`
	SystemPrompt string           `json:"systemPrompt"`
	Messages     []Message        `json:"messages"`
	Tools        []ToolDefinition `json:"tools"`
	Settings     Settings         `json:"settings"`
	runtimeWire  json.RawMessage
}
type Message struct {
	Role         string          `json:"role"`
	Content      Content         `json:"content"`
	Stop         string          `json:"stop,omitempty"`
	ToolCallID   string          `json:"toolCallId,omitempty"`
	ToolName     string          `json:"toolName,omitempty"`
	IsError      bool            `json:"isError,omitempty"`
	ProviderData json.RawMessage `json:"providerData,omitempty"`
}
type AssistantMessage struct {
	Role    string  `json:"role"`
	Content Content `json:"content"`
	Stop    string  `json:"stop"`
	Usage   Usage   `json:"usage,omitzero"`
	// UsageReported distinguishes an explicit zero from missing usage.
	UsageReported bool            `json:"-"`
	Error         *ModelError     `json:"error,omitempty"`
	ProviderData  json.RawMessage `json:"providerData,omitempty"`
	runtimeWire   json.RawMessage
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
	ID        string
	Models    func() []ModelInfo
	Supports  ProviderSupport
	Available func() bool
	// Availability, when set, replaces Available and may give a credential-free reason.
	Availability   func() (bool, string)
	Request        func(context.Context, ModelRef, ModelRequest, *ProviderContext) (AssistantMessage, error)
	DiscardState   func(context.Context, string) error
	EraseState     func(context.Context, string, []string) (ProviderErasure, error)
	CatalogChanges *CatalogChanges
}

// CatalogChanges lets a Provider invalidate a cached catalog after changing it.
type CatalogChanges struct {
	mu      sync.Mutex
	version uint64
	catalog []api.Model
	valid   bool
}

func (c *CatalogChanges) Changed() { c.mu.Lock(); c.version++; c.valid = false; c.mu.Unlock() }

type providerAdapter struct {
	p    Provider
	read func(context.Context, string) (string, error)
}

func (p providerAdapter) Available() bool { ready, _ := p.Availability(); return ready }
func (p providerAdapter) Availability() (bool, string) {
	if p.p.Availability != nil {
		return p.p.Availability()
	}
	return p.p.Available == nil || p.p.Available(), ""
}

func (p providerAdapter) Catalog() []api.Model {
	c := p.p.CatalogChanges
	if c == nil {
		return p.catalog()
	}
	c.mu.Lock()
	if c.valid {
		out := c.catalog
		c.mu.Unlock()
		return out
	}
	version := c.version
	c.mu.Unlock()
	out := p.catalog()
	c.mu.Lock()
	if c.version == version {
		c.catalog, c.valid = out, true
	}
	c.mu.Unlock()
	return out
}
func (p providerAdapter) catalog() []api.Model {
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
			return modelAccess{p, m}, nil
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

// ProviderErasure describes remote deletion that could not be confirmed.
type ProviderErasure = api.ProviderErasure

func (p providerAdapter) EraseState(ctx context.Context, session string, entries []string) (api.ProviderErasure, error) {
	if p.p.EraseState == nil {
		return api.ProviderErasure{}, &Error{Code: NotSupported, Message: "Provider cannot erase remote state"}
	}
	return p.p.EraseState(ctx, session, entries)
}

type modelAccess struct {
	p     providerAdapter
	model api.Model
}

func (m modelAccess) Model() api.Model { return m.model }
func (m modelAccess) Generate(ctx context.Context, r api.Request, emit func(api.Part)) (api.Response, error) {
	if !m.p.Available() {
		return failedModelResponse(&ModelError{Kind: Temporary, Message: "Provider unavailable"}), nil
	}
	var request ModelRequest
	if err := decodeInto(portable.Request(r), &request); err != nil {
		return failedModelResponse(err), nil
	}
	if request.SessionID == "" {
		request.SessionID = api.Executing(ctx).Session
	}
	ref := ModelRef{Provider: m.model.Provider, ID: strings.TrimPrefix(m.model.ID, m.model.Provider+"/")}
	var settled atomic.Bool
	defer settled.Store(true)
	pc := &ProviderContext{credential: func() (string, error) {
		if settled.Load() {
			return "", &Error{Code: InvalidRequest, Message: "Provider request has settled"}
		}
		if err := ctx.Err(); err != nil {
			return "", appError(err, CancelledCode)
		}
		if m.p.read == nil {
			return "", &Error{Code: NotFound, Message: "provider credential unavailable"}
		}
		key, err := m.p.read(ctx, ref.Provider)
		if err != nil {
			return "", err
		}
		if key == "" {
			return "", &Error{Code: NotFound, Message: "provider credential unavailable"}
		}
		return key, nil
	}, piece: func(p Part) {
		if ctx.Err() == nil && !settled.Load() {
			if c := portable.ReadContent(Content{p}); len(c) > 0 {
				emit(c[0])
			}
		}
	}}
	response, err := m.p.p.Request(ctx, ref, request, pc)
	settled.Store(true)
	if ctx.Err() != nil {
		return api.Response{}, ctx.Err()
	}
	if err != nil {
		return failedModelResponse(err), nil
	}
	response.Role = "assistant"
	if response.Content == nil {
		response.Content = Content{}
	}
	var o portable.Object
	if err := decodeInto(response, &o); err != nil {
		return failedModelResponse(err), nil
	}
	res := portable.ReadResponse(o)
	res.UsageReported = res.UsageReported || response.UsageReported
	return res, nil
}

func failedModelResponse(err error) api.Response {
	var failure *ModelError
	if !errors.As(err, &failure) || failure == nil {
		failure = &ModelError{Kind: Other, Message: err.Error()}
	}
	return portable.ReadResponse(portable.Object{"role": "assistant", "content": []any{}, "stop": "failed", "error": failure})
}
func (a *Agent) Models() []ModelInfo {
	var result []ModelInfo
	for _, p := range a.a.All("provider.") {
		if refresh, ok := p.(interface{ RefreshCatalog(context.Context) error }); ok {
			_ = refresh.RefreshCatalog(context.Background())
		}
		for _, m := range p.(api.Provider).Catalog() {
			var info ModelInfo
			if decodeInto(portable.Model(m), &info) == nil {
				result = append(result, info)
			}
		}
	}
	return result
}
