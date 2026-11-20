package modular

import (
	"encoding/json"
	"io/fs"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
)

type memoryStore struct {
	mu   sync.Mutex
	data map[string][]byte
	held map[string]bool
}
type lease struct {
	store  *memoryStore
	id     string
	closed bool
}

func (m *memoryStore) Acquire(id string) (api.Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.held[id] {
		return nil, &Error{Code: Held, Message: "history has another writer", Data: map[string]any{"retryAfterMs": 100}}
	}
	m.held[id] = true
	return &lease{store: m, id: id}, nil
}
func (l *lease) Load() (api.Session, error) {
	m := l.store
	m.mu.Lock()
	defer m.mu.Unlock()
	if l.closed {
		return api.Session{}, fs.ErrClosed
	}
	b := m.data[l.id]
	if b == nil {
		return api.Session{}, fs.ErrNotExist
	}
	var s api.Session
	err := json.Unmarshal(b, &s)
	return s, err
}
func (l *lease) Save(s api.Session) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	m := l.store
	m.mu.Lock()
	defer m.mu.Unlock()
	if l.closed {
		return fs.ErrClosed
	}
	m.data[l.id] = b
	return nil
}
func (l *lease) Close() error {
	m := l.store
	m.mu.Lock()
	defer m.mu.Unlock()
	if !l.closed {
		delete(m.held, l.id)
		l.closed = true
	}
	return nil
}
func (m *memoryStore) List(project string) ([]api.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []api.Session
	for _, b := range m.data {
		var s api.Session
		if err := json.Unmarshal(b, &s); err != nil {
			return nil, err
		}
		if project == "" || s.Project == project {
			out = append(out, s)
		}
	}
	return out, nil
}
func (l *lease) SaveErasure(s api.Session) error { return l.Save(s) }

func (m *memoryStore) Erase(ids []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	selected := map[string]bool{}
	for _, id := range ids {
		selected[id] = true
	}
	staged := map[string][]byte{}
	for id, data := range m.data {
		var s api.Session
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		for n, e := range s.Entries {
			if !selected[e.ID] || e.IsErased() {
				continue
			}
			if e.AuthorityRecord() {
				return &Error{Code: Forbidden, Message: "cannot erase authority record"}
			}
			s.Entries[n] = e.Redacted()
		}
		encoded, err := json.Marshal(s)
		if err != nil {
			return err
		}
		staged[id] = encoded
	}
	m.data = staged
	return nil
}
