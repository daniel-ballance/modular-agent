package modular

import (
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/history"
)

type HistoryStore struct {
	make       func() (api.Store, error)
	persistent bool
}

func MemoryHistory() HistoryStore {
	return HistoryStore{make: func() (api.Store, error) {
		return &memoryStore{data: make(map[string][]byte), held: make(map[string]bool)}, nil
	}}
}
func FileHistory(dir string) HistoryStore {
	return HistoryStore{persistent: true, make: func() (api.Store, error) { return history.New(dir) }}
}
func WithHistory(store HistoryStore) Option {
	return func(o *options) error { o.history = store; return nil }
}
