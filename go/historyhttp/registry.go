package historyhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// This is a Go deployment extension, not part of modular-agent-history/1.
const registryPath = "/go/pending-erasure"
const registryLimit = 8 << 20

type registryState struct {
	Guard    string              `json:"guard"`
	Revision string              `json:"revision"`
	History  string              `json:"history,omitempty"`
	Intents  []api.ErasureIntent `json:"intents"`
}

func (s *Server) registryFile() string { return filepath.Join(s.dir, ".erasure-registry") }

func (s *Server) startupRegistry() error {
	if _, err := os.Stat(s.registryFile()); err == nil {
		s.registry = true
		_, err = s.loadRegistry()
		return err
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Do not silently replace a missing registry on an established service.
	if _, err := os.Stat(filepath.Join(s.dir, ".lease-ttl-ms")); err == nil {
		if _, err := os.Stat(filepath.Join(s.dir, ".erasure-required")); errors.Is(err, os.ErrNotExist) {
			return nil // Legacy service with no coordinator.
		}
		return api.ErrErasureUnavailable
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.registry = true
	if err := atomicFile(s.dir, s.registryFile(), raw(registryState{Guard: api.ID(), Revision: api.ID()})); err != nil {
		return err
	}
	return atomicFile(s.dir, filepath.Join(s.dir, ".erasure-required"), []byte("1"))
}

// Called with the server lock after startup. Read from disk so that loss of
// the authoritative file does not get mistaken for an empty registry.
func (s *Server) loadRegistry() (state registryState, err error) {
	if !s.registry {
		return state, api.ErrErasureUnsupported
	}
	f, err := os.Open(s.registryFile())
	if err != nil {
		return state, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, registryLimit+1))
	if err != nil || len(b) > registryLimit || json.Unmarshal(b, &state) != nil || state.Revision == "" || state.Guard == "" {
		return registryState{}, api.ErrErasureUnavailable
	}
	return state, nil
}

func (s *Server) serveRegistry(w http.ResponseWriter, r *http.Request) {
	var next registryState
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, registryLimit+1))
		if err != nil || len(b) > registryLimit || json.Unmarshal(b, &next) != nil {
			invalid(w)
			return
		}
	default:
		invalid(w)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.registry {
		failure(w, 404, "not_found", "no pending erasure registry")
		return
	}
	if s.lock == nil || s.closed {
		unavailable(w)
		return
	}
	state, err := s.loadRegistry()
	if err != nil {
		unavailable(w)
		return
	}
	if r.Method == http.MethodGet {
		state.History = s.historyRev
		respond(w, 200, state)
		return
	}
	if state.Revision != next.Revision || len(next.Intents) < len(state.Intents) ||
		(len(next.Intents) > len(state.Intents) && next.History != s.historyRev) {
		failure(w, 409, "unavailable", "pending erasure state changed")
		return
	}
	if len(next.Intents) != len(state.Intents) {
		state.Guard = api.ID()
	}
	state.Revision = api.ID()
	state.Intents = next.Intents
	b := raw(state)
	if len(b) > registryLimit || atomicFile(s.dir, s.registryFile(), b) != nil {
		unavailable(w)
		return
	}
	respond(w, 200, fields{})
}

func (c *Client) ErasureCoordinated() bool { return c.coordinated.Load() }

func (c *Client) readRegistry() (state registryState, err error) {
	if !c.ErasureCoordinated() {
		return state, api.ErrErasureUnsupported
	}
	err = (httpBackend{c.wire}).call(c.ctx, "GET", registryPath, nil, &state)
	if err != nil || state.Guard == "" || state.Revision == "" || state.History == "" {
		return state, errors.Join(api.ErrErasureUnavailable, err)
	}
	return state, nil
}

func (c *Client) GuardErasure(fn func([]api.ErasureIntent, string) error) error {
	state, err := c.readRegistry()
	if err != nil {
		return err
	}
	return fn(state.Intents, state.Guard)
}

func (c *Client) PendingErasures(fn func(*[]api.ErasureIntent) error) error {
	state, err := c.readRegistry()
	if err != nil {
		return err
	}
	before := raw(state.Intents)
	if err := fn(&state.Intents); err != nil {
		return err
	}
	if bytes.Equal(before, raw(state.Intents)) {
		return nil
	}
	var out fields
	if err := (httpBackend{c.wire}).call(c.ctx, "POST", registryPath, state, &out); err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	return nil
}

// SaveErasure sends only the requested tombstones. Reconciliation reloads
// the records under this lease before it acknowledges any of them.
func (l *lease) SaveErasure(next api.Session) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.usable(); err != nil {
		return err
	}
	if next.ID != l.id || l.token == "" || l.known == nil {
		return api.ErrErasureUnavailable
	}
	var ids []string
	for _, entry := range next.Entries {
		if old := l.known[entry.ID]; old != nil && entry.IsErased() && !bytes.Equal(objectOf(old)["erased"], []byte("true")) {
			ids = append(ids, entry.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(l.c.ctx, time.Duration(l.cutoff.Load()-leaseClock()))
	defer cancel()
	if _, err := l.c.backend.Erase(ctx, l.id, l.token, ids); err != nil {
		l.fence()
		return err
	}
	return l.CheckWriter()
}
