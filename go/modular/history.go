package modular

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/history"
	"github.com/OWNER/modular-agent/go/historyhttp"
	"github.com/OWNER/modular-agent/go/servicehttp"
)

type HistoryStore struct {
	make       func() (api.Store, error)
	persistent bool
	serviceDir string
	fileDir    string
}

func MemoryHistory() HistoryStore {
	store := &memoryStore{data: make(map[string][]byte), held: make(map[string]bool)}
	return HistoryStore{make: func() (api.Store, error) { return store, nil }}
}
func FileHistory(dir string) HistoryStore {
	return HistoryStore{persistent: true, fileDir: dir, make: func() (api.Store, error) { return history.New(dir) }}
}

// HTTPHistory uses a modular-agent-history/1 service as a HistoryStore.
func HTTPHistory(url, tokenFile string) HistoryStore {
	return HistoryStore{persistent: true, make: func() (api.Store, error) {
		token, err := historyhttp.TokenFile(tokenFile)
		if err != nil {
			return nil, err
		}
		client := historyhttp.NewClient(servicehttp.NewClient(url, token))
		if err = client.Verify(); err != nil {
			_ = client.Close()
			return nil, err
		}
		return client, nil
	}}
}

// HistoryServiceFiles selects the base history service's own file layout.
// Its directory is not interchangeable with FileHistory's directory.
func HistoryServiceFiles(dir string) HistoryStore { return HistoryStore{serviceDir: dir} }

type HistoryOptions struct {
	Address   string
	TokenFile string
}

func ServeHistory(ctx context.Context, store HistoryStore, options HistoryOptions) error {
	listener, err := net.Listen("tcp", options.Address)
	if err != nil {
		return appError(err, InvalidParams)
	}
	defer listener.Close()
	return serveHistory(ctx, store, options, listener)
}
func serveHistory(ctx context.Context, store HistoryStore, options HistoryOptions, listener net.Listener) error {
	token, err := historyhttp.TokenFile(options.TokenFile)
	if err != nil {
		return appError(err, InvalidParams)
	}
	var handler http.Handler
	var disk *historyhttp.Server
	switch {
	case store.serviceDir != "":
		disk, err = historyhttp.New(store.serviceDir, 3*time.Second)
	case store.make != nil:
		var backing api.Store
		backing, err = store.make()
		if err == nil {
			if client, ok := backing.(*historyhttp.Client); ok {
				defer client.Close()
				handler = client.Relay(token)
			} else if store.fileDir != "" {
				disk, err = historyhttp.NewFileStoreServer(backing, store.fileDir, 3*time.Second)
			} else {
				disk = historyhttp.NewStoreServer(backing, 3*time.Second)
			}
		}
	default:
		err = errors.New("missing history store")
	}
	if err != nil {
		return appError(err, InvalidComposition)
	}
	if disk != nil {
		defer disk.Close()
		handler = disk.Handler(token)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	stop := context.AfterFunc(ctx, func() { _ = server.Close() })
	defer stop()
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return appError(err, Lost)
}

func WithHistory(store HistoryStore) Option {
	return func(o *options) error { o.history = store; return nil }
}
