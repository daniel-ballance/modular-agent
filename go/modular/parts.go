package modular

import (
	"context"
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// HistoryBackend is the local lease-backed history adapter. Each Save is a
// commit of the complete ordered record and must keep its opaque entries.
type HistoryBackend = api.Store
type HistoryLease = api.Lease
type SessionRecord = api.Session
type HistoryRecord = api.Entry

// NewHistoryStore wraps a lease-backed implementation. Persistent stores must
// survive a process restart. Set erasure only if their Erase operation works.
func NewHistoryStore(backend HistoryBackend, persistent, erasure bool) HistoryStore {
	if backend == nil {
		return HistoryStore{}
	}
	return HistoryStore{make: func() (api.Store, error) { return backend, nil }, persistent: persistent, erasure: erasure}
}

// Configuration provides operator-controlled settings and project trust.
type Configuration interface {
	Settings(project string) (Settings, error)
	Trusted(project string) (bool, error)
}

type configurationAdapter struct {
	source   Configuration
	defaults *api.Settings
}

func (c configurationAdapter) Settings(project string) (api.Settings, error) {
	values, err := c.source.Settings(project)
	settings := *c.defaults
	if err != nil {
		return settings, err
	}
	for key, v := range values {
		if err = applySetting(&settings, key, v); err != nil {
			return settings, err
		}
	}
	return settings, nil
}
func (c configurationAdapter) Trusted(project string) (bool, error) { return c.source.Trusted(project) }

// Interface is a local front end. Start may launch work but must return when
// ready. Stop releases the front end and waits for its work to finish.
type Interface interface {
	Start(context.Context, *Agent) error
	Stop() error
}

func (r *Registrar) HistoryStore(store HistoryStore) error {
	if store.make == nil {
		return r.fail(errors.New("invalid history store"))
	}
	if err := r.add("history"); err != nil {
		return err
	}
	r.history = store
	return nil
}
func (r *Registrar) CredentialStore(store CredentialStore) error {
	if store == nil {
		return r.fail(errors.New("invalid credential store"))
	}
	if err := r.add("credentials"); err != nil {
		return err
	}
	r.credentials = store
	return nil
}
func (r *Registrar) Configuration(source Configuration) error {
	if source == nil {
		return r.fail(errors.New("invalid configuration source"))
	}
	if err := r.add("configuration"); err != nil {
		return err
	}
	r.configuration = source
	return nil
}
func (r *Registrar) Interface(front Interface) error {
	if front == nil {
		return r.fail(errors.New("invalid Interface"))
	}
	if err := r.add("interface"); err != nil {
		return err
	}
	r.front = front
	return nil
}
