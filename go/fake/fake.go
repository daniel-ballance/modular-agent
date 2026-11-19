// Package fake is a scripted, offline Provider. It never reads credentials.
package fake

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
	"strings"
	"sync"
)

type Script struct {
	Require  string
	Response api.Response
	Err      error `json:"-"`
	Chunks   []api.Part
	Run      func(context.Context, api.Request, func(api.Part)) (api.Response, error) `json:"-"`
}
type Provider struct {
	mu       sync.Mutex
	scripts  []Script
	requests []api.Request
}

func New(scripts ...Script) *Provider { return &Provider{scripts: scripts} }
func (p *Provider) Plugin() api.Plugin {
	return api.Plugin{Name: "fake", Setup: func(a api.API) error { return a.Provide("provider.fake", p) }}
}
func (p *Provider) Catalog() []api.Model {
	return []api.Model{{ID: "fake", Provider: "fake", Context: 8000, Output: 1024, Thinking: []string{"off", "low", "high"}}, {ID: "fake-alt", Provider: "fake", Context: 8000, Output: 1024, Thinking: []string{"off", "high"}}}
}
func (p *Provider) Access(id string) (api.ModelAccess, error) {
	for _, m := range p.Catalog() {
		if m.ID == id {
			return &access{p, m}, nil
		}
	}
	return nil, errors.New("fake model not found")
}

type access struct {
	p     *Provider
	model api.Model
}

func (a *access) Model() api.Model { return a.model }
func (a *access) Generate(ctx context.Context, r api.Request, emit func(api.Part)) (api.Response, error) {
	p := a.p
	p.mu.Lock()
	p.requests = append(p.requests, copyRequest(r))
	if len(p.scripts) == 0 {
		p.mu.Unlock()
		return api.Response{}, errors.New("fake script exhausted")
	}
	s := p.scripts[0]
	p.scripts = p.scripts[1:]
	p.mu.Unlock()
	if s.Require != "" && !strings.Contains(string(api.JSON(r)), s.Require) {
		return api.Response{}, errors.New("fake request did not contain required context")
	}
	if s.Run != nil {
		return s.Run(ctx, r, emit)
	}
	for _, part := range s.Chunks {
		if err := ctx.Err(); err != nil {
			return api.Response{}, err
		}
		emit(part)
	}
	return s.Response, s.Err
}
func copyRequest(r api.Request) api.Request {
	var out api.Request
	_ = json.Unmarshal(api.JSON(r), &out)
	return out
}
func (p *Provider) Requests() []api.Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]api.Request, len(p.requests))
	for i, r := range p.requests {
		out[i] = copyRequest(r)
	}
	return out
}
