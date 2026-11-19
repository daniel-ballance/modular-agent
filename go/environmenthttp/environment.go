// Package environmenthttp adapts WorkingEnvironment to a rooted filesystem and
// Bubblewrap commands. Sources: https://pkg.go.dev/os#Root and
// https://github.com/containers/bubblewrap (bwrap --help for installed options).
package environmenthttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type request struct {
	Owner, Project, Name, Command string
	Data                          []byte
}
type frame struct {
	Kind, Text, Error string
	Data              []byte
	Unknown           bool
}
type owner struct {
	env  *worker
	done chan struct{}
}
type Server struct {
	mu          sync.Mutex
	root        *os.Root
	path, bwrap string
	owners      map[string]*owner
	closed      bool
}

func New(root string) (*Server, error) {
	p, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	p, err = filepath.Abs(p)
	if err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(p)
	if err != nil {
		return nil, err
	}
	b, err := exec.LookPath("bwrap")
	if err != nil {
		r.Close()
		return nil, errors.New("Bubblewrap required for sandbox commands")
	}
	return &Server{root: r, path: p, bwrap: b, owners: map[string]*owner{}}, nil
}
func (s *Server) Close() error {
	s.mu.Lock()
	s.closed = true
	ls := make([]*owner, 0, len(s.owners))
	for _, o := range s.owners {
		ls = append(ls, o)
	}
	s.mu.Unlock()
	for _, o := range ls {
		_ = o.env.Close()
	}
	return s.root.Close()
}
func (s *Server) Handler(token string) http.Handler {
	return servicehttp.Auth(token, http.HandlerFunc(s.serve))
}
func (s *Server) relative(project, name string) (string, error) {
	if !filepath.IsAbs(project) {
		return "", errors.New("absolute project required")
	}
	rel, err := filepath.Rel(s.path, project)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", errors.New("project outside sandbox")
	}
	// Validate the project itself with the rooted API, including symlinks.
	p, err := s.root.OpenRoot(rel)
	if err != nil {
		return "", err
	}
	p.Close()
	target := filepath.Join(project, name)
	if filepath.IsAbs(name) {
		target = name
	}
	rel, err = filepath.Rel(s.path, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", errors.New("path outside sandbox")
	}
	return rel, nil
}
func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var q request
	if !servicehttp.Decode(w, r, &q) {
		return
	}
	if r.URL.Path == "/v1/environment/connect" {
		s.connect(w, r, q.Owner)
		return
	}
	s.mu.Lock()
	o := s.owners[q.Owner]
	closed := s.closed
	s.mu.Unlock()
	if o == nil || closed {
		servicehttp.Fail(w, errors.New("environment lost: agent connection is closed"))
		return
	}
	rel, err := s.relative(q.Project, q.Name)
	if err != nil {
		servicehttp.Fail(w, err)
		return
	}
	switch r.URL.Path {
	case "/v1/environment/read":
		data, err := s.root.ReadFile(rel)
		if err != nil {
			servicehttp.Fail(w, err)
			return
		}
		servicehttp.JSON(w, frame{Data: data})
	case "/v1/environment/write":
		err = s.root.MkdirAll(filepath.Dir(rel), 0755)
		if err == nil {
			err = s.root.WriteFile(rel, q.Data, 0644)
		}
		if err != nil {
			servicehttp.Fail(w, err)
			return
		}
		servicehttp.JSON(w, frame{Kind: "done"})
	case "/v1/environment/bash":
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		go func() {
			select {
			case <-o.done:
				cancel()
			case <-ctx.Done():
			}
		}()
		w.Header().Set("Content-Type", "application/x-ndjson")
		if servicehttp.Frame(w, frame{Kind: "ready"}) != nil {
			return
		}
		var mu sync.Mutex
		text, err := o.env.Bash(ctx, q.Project, q.Command, func(text string) {
			mu.Lock()
			defer mu.Unlock()
			if servicehttp.Frame(w, frame{Kind: "output", Text: text}) != nil {
				cancel()
			}
		})
		mu.Lock()
		defer mu.Unlock()
		end := frame{Kind: "done", Text: text}
		if err != nil {
			end.Error = err.Error()
			end.Unknown = errors.Is(err, api.ErrUnknownOutcome)
		}
		_ = servicehttp.Frame(w, end)
	default:
		http.NotFound(w, r)
	}
}
func (s *Server) connect(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.Lock()
	if id == "" || s.closed || s.owners[id] != nil {
		s.mu.Unlock()
		servicehttp.Fail(w, errors.New("invalid or already connected owner"))
		return
	}
	e, err := s.startWorker()
	if err != nil {
		s.mu.Unlock()
		servicehttp.Fail(w, err)
		return
	}
	o := &owner{e, make(chan struct{})}
	s.owners[id] = o
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.owners, id); close(o.done); s.mu.Unlock(); _ = e.Close() }()
	w.Header().Set("Content-Type", "application/x-ndjson")
	if servicehttp.Frame(w, frame{Kind: "ready"}) != nil {
		return
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if closed || servicehttp.Frame(w, frame{Kind: "heartbeat"}) != nil {
				return
			}
		}
	}
}

type Client struct {
	wire   *servicehttp.Client
	owner  string
	cancel context.CancelFunc
	body   io.ReadCloser
	done   chan struct{}
	once   sync.Once
}

func NewClient(wire *servicehttp.Client) (*Client, error) {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{wire: wire, owner: api.ID(), cancel: cancel, done: make(chan struct{})}
	// Stream establishment has a bounded header wait, without timing out its lifetime.
	res, err := wire.Open(ctx, "/v1/environment/connect", "", request{Owner: c.owner})
	if err != nil {
		cancel()
		return nil, err
	}
	c.body = res.Body
	d := json.NewDecoder(res.Body)
	var f frame
	if err = d.Decode(&f); err != nil || f.Kind != "ready" {
		cancel()
		res.Body.Close()
		return nil, errors.New("environment connection failed")
	}
	go func() {
		defer close(c.done)
		defer cancel()
		defer res.Body.Close()
		for {
			if d.Decode(&f) != nil {
				return
			}
		}
	}()
	return c, nil
}
func (c *Client) StopsOnCrash() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}
func (c *Client) Close() error {
	c.once.Do(func() { c.cancel(); c.body.Close(); <-c.done })
	return nil
}
func (c *Client) Read(ctx context.Context, project, name string) ([]byte, error) {
	var f frame
	err := c.wire.Call(ctx, "/v1/environment/read", "", request{Owner: c.owner, Project: project, Name: name}, &f)
	return f.Data, err
}
func (c *Client) Write(ctx context.Context, project, name string, data []byte) error {
	res, err := c.wire.Open(ctx, "/v1/environment/write", "", request{Owner: c.owner, Project: project, Name: name, Data: data})
	if err != nil {
		return fmt.Errorf("%w: %v", api.ErrUnknownOutcome, err)
	}
	defer res.Body.Close()
	var f frame
	if err := json.NewDecoder(res.Body).Decode(&f); err != nil {
		return fmt.Errorf("%w: write answer lost: %v", api.ErrUnknownOutcome, err)
	}
	return nil
}
func (c *Client) Bash(ctx context.Context, project, command string, emit func(string)) (string, error) {
	res, err := c.wire.Open(ctx, "/v1/environment/bash", "", request{Owner: c.owner, Project: project, Command: command})
	if err != nil {
		return "", fmt.Errorf("%w: %v", api.ErrUnknownOutcome, err)
	}
	defer res.Body.Close()
	d := json.NewDecoder(res.Body)
	for {
		var f frame
		if err = d.Decode(&f); err != nil {
			return "", fmt.Errorf("%w: environment stream lost: %v", api.ErrUnknownOutcome, err)
		}
		switch f.Kind {
		case "output":
			if emit != nil {
				emit(f.Text)
			}
		case "done":
			if f.Error != "" {
				if f.Unknown {
					return f.Text, fmt.Errorf("%w: %s", api.ErrUnknownOutcome, f.Error)
				}
				return f.Text, errors.New(f.Error)
			}
			return f.Text, nil
		}
	}
}
func Plugin(wire *servicehttp.Client) api.Plugin {
	var c *Client
	return api.Plugin{Name: "environment-http", Setup: func(a api.API) error {
		var err error
		c, err = NewClient(wire)
		if err != nil {
			return err
		}
		return a.Provide("working-environment", c)
	}, Close: func() error {
		if c != nil {
			return c.Close()
		}
		return nil
	}}
}
