// Package gateway keeps Provider credentials behind authenticated model access.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"net/http"
	"sync"
)

type Server struct{ provider api.Provider }

func New(p api.Provider) *Server { return &Server{p} }
func (s *Server) Handler(token string) http.Handler {
	return servicehttp.Auth(token, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.NotFound(w, r)
			return
		}
		switch r.URL.Path {
		case "/v1/model/catalog":
			servicehttp.JSON(w, s.provider.Catalog())
		case "/v1/model/generate":
			var q struct {
				Model   string
				Request api.Request
			}
			if !servicehttp.Decode(w, r, &q) {
				return
			}
			a, err := s.provider.Access(q.Model)
			if err != nil {
				servicehttp.Fail(w, err)
				return
			}
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			w.Header().Set("Content-Type", "application/x-ndjson")
			if servicehttp.Frame(w, frame{Kind: "ready"}) != nil {
				return
			}
			var mu sync.Mutex
			out, err := a.Generate(ctx, q.Request, func(p api.Part) {
				mu.Lock()
				defer mu.Unlock()
				if servicehttp.Frame(w, frame{Kind: "part", Part: p}) != nil {
					cancel()
				}
			})
			mu.Lock()
			defer mu.Unlock()
			f := frame{Kind: "done", Response: out}
			if err != nil {
				f.Kind = "error"
				f.Error = err.Error()
				var modelErr *api.ModelError
				if errors.As(err, &modelErr) {
					f.ErrorKind = modelErr.Kind
				}
			}
			_ = servicehttp.Frame(w, f)
		default:
			http.NotFound(w, r)
		}
	}))
}

type frame struct {
	Kind             string
	Part             api.Part
	Response         api.Response
	Error, ErrorKind string
}
type Client struct {
	wire   *servicehttp.Client
	models []api.Model
}

func NewClient(wire *servicehttp.Client) (*Client, error) {
	c := &Client{wire: wire}
	err := wire.Call(context.Background(), "/v1/model/catalog", "", struct{}{}, &c.models)
	return c, err
}
func (c *Client) Catalog() []api.Model { return append([]api.Model(nil), c.models...) }
func (c *Client) Access(id string) (api.ModelAccess, error) {
	for _, m := range c.models {
		if id == m.ID {
			return &access{c, m}, nil
		}
	}
	return nil, errors.New("gateway model not available")
}

type access struct {
	c *Client
	m api.Model
}

func (a *access) Model() api.Model { return a.m }
func (a *access) Generate(ctx context.Context, q api.Request, emit func(api.Part)) (api.Response, error) {
	res, err := a.c.wire.Open(ctx, "/v1/model/generate", "", struct {
		Model   string
		Request api.Request
	}{a.m.ID, q})
	if err != nil {
		return api.Response{}, fmt.Errorf("%w: model gateway request failed: %v", api.ErrUnknownOutcome, err)
	}
	defer res.Body.Close()
	d := json.NewDecoder(res.Body)
	for {
		var f frame
		if err = d.Decode(&f); err != nil {
			return api.Response{}, fmt.Errorf("%w: model gateway stream lost: %v", api.ErrUnknownOutcome, err)
		}
		switch f.Kind {
		case "ready":
			continue
		case "part":
			if emit != nil {
				emit(f.Part)
			}
		case "done":
			return f.Response, nil
		case "error":
			if f.ErrorKind != "" {
				return api.Response{}, &api.ModelError{Kind: f.ErrorKind, Message: f.Error}
			}
			return api.Response{}, errors.New(f.Error)
		default:
			return api.Response{}, errors.New("invalid gateway frame")
		}
	}
}
func Plugin(wire *servicehttp.Client) api.Plugin {
	return api.Plugin{Name: "model-gateway", Setup: func(a api.API) error {
		c, err := NewClient(wire)
		if err != nil {
			return err
		}
		return a.Provide("provider.gateway", c)
	}}
}
