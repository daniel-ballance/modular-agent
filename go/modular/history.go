package modular

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
)

type HistoryStore struct {
	make           func() (api.Store, error)
	persistent     bool
	erasure        bool
	serviceDir     string
	fileDir        string
	serviceBackend api.Store
}

func MemoryHistory() HistoryStore {
	return memoryHistory(&memoryStore{data: make(map[string][]byte), held: make(map[string]bool)})
}
func memoryHistory(store *memoryStore) HistoryStore {
	return HistoryStore{erasure: true, make: func() (api.Store, error) { return store, nil }}
}
func FileHistory(dir string) HistoryStore {
	return HistoryStore{persistent: true, erasure: true, fileDir: dir, make: func() (api.Store, error) { return history.New(dir) }}
}

// HTTPHistory uses a modular-agent-history/1 service as a HistoryStore.
func HTTPHistory(url, tokenFile string) HistoryStore {
	return HistoryStore{persistent: true, erasure: true, make: func() (api.Store, error) {
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
	// LeaseTTL is the writer lease duration. Zero uses 15 seconds. A nonzero
	// value must be a positive whole number of milliseconds. An HTTP relay
	// uses the upstream service's lease duration instead.
	LeaseTTL time.Duration
	// StateDir holds the restart exclusion bound for a custom snapshot
	// backend. Use a persistent, private directory dedicated to this service.
	StateDir string
	// AllowVolatileForTests explicitly permits serving MemoryHistory.
	AllowVolatileForTests bool
}

// ServeHistory starts serving history and returns the bound URL, including for port 0.
func ServeHistory(ctx context.Context, store HistoryStore, options HistoryOptions) (*HistoryService, error) {
	return ListenHistory(ctx, store, options)
}

// HistoryService holds a running loopback history service.
type HistoryService struct {
	URL    string
	cancel context.CancelFunc
	done   chan struct{}
	err    error
}

func (s *HistoryService) Close() error {
	s.cancel()
	<-s.done
	return s.err
}

// ListenHistory starts serving history and returns the actual address (including for port 0).
func ListenHistory(ctx context.Context, store HistoryStore, options HistoryOptions) (*HistoryService, error) {
	listener, err := net.Listen("tcp", options.Address)
	if err != nil {
		return nil, appError(err, InvalidParams)
	}
	ctx, cancel := context.WithCancel(ctx)
	service := &HistoryService{URL: "http://" + listener.Addr().String(), cancel: cancel, done: make(chan struct{})}
	ready := make(chan struct{})
	go func() {
		defer close(service.done)
		defer listener.Close()
		service.err = runHistory(ctx, store, options, listener, ready)
	}()
	select {
	case <-ready:
		return service, nil
	case <-service.done:
		cancel()
		return nil, service.err
	}
}

func serveHistory(ctx context.Context, store HistoryStore, options HistoryOptions, listener net.Listener) error {
	return runHistory(ctx, store, options, listener, nil)
}

func runHistory(ctx context.Context, store HistoryStore, options HistoryOptions, listener net.Listener, ready chan<- struct{}) error {
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok || !addr.IP.IsLoopback() {
		return &Error{Code: InvalidParams, Message: "plaintext history requires a loopback listener"}
	}
	ttl := options.LeaseTTL
	if ttl == 0 {
		ttl = 15 * time.Second
	} else if ttl < time.Millisecond || ttl%time.Millisecond != 0 {
		return &Error{Code: InvalidParams, Message: "history lease TTL must be a positive whole number of milliseconds"}
	}
	if store.serviceDir == "" && store.make == nil {
		return &Error{Code: NotSupported, Message: "no eligible history store selected"}
	}
	token, err := historyhttp.TokenFile(options.TokenFile)
	if err != nil {
		return appError(err, InvalidParams)
	}
	var handler http.Handler
	var disk *historyhttp.Server
	switch {
	case store.serviceDir != "":
		disk, err = historyhttp.New(store.serviceDir, ttl)
	case store.make != nil:
		var backing api.Store
		backing, err = store.make()
		if err == nil {
			if client, ok := backing.(*historyhttp.Client); ok {
				defer client.Close()
				handler = client.Relay(token)
			} else if store.fileDir != "" {
				disk, err = historyhttp.NewFileStoreServer(backing, store.fileDir, ttl)
			} else if _, ok := backing.(*memoryStore); ok {
				if !options.AllowVolatileForTests {
					return &Error{Code: NotSupported, Message: "MemoryHistory is not durable and can only be served for tests"}
				}
				disk = historyhttp.NewStoreServer(backing, ttl)
			} else if store.persistent && store.erasure && store.serviceBackend != nil && options.StateDir != "" {
				disk, err = historyhttp.NewFileStoreServer(store.serviceBackend, options.StateDir, ttl)
			} else {
				return &Error{Code: NotSupported, Message: "custom history backend requires ServiceHistoryBackend, persistence, erasure and a persistent HistoryOptions.StateDir"}
			}
		}
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
	if ready != nil {
		close(ready)
	}
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return appError(err, Lost)
}

func WithHistory(store HistoryStore) Option {
	return func(o *options) error { o.history = store; return nil }
}
