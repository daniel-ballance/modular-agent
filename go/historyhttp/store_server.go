package historyhttp

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

// NewStoreServer serves a snapshot store under the same HTTP rules as the
// dedicated filesystem service. The service holds the store's own writer
// lease throughout each HTTP lease, including between HTTP requests.
func NewStoreServer(store api.Store, ttl time.Duration) *Server {
	if ttl < time.Millisecond {
		ttl = 3 * time.Second
	}
	return &Server{store: store, ttl: ttl.Truncate(time.Millisecond), held: map[string]held{}, storeLeases: map[string]api.Lease{}, timers: map[string]*time.Timer{}}
}

// NewFileStoreServer persists the restart exclusion bound alongside a file store.
func NewFileStoreServer(store api.Store, dir string, ttl time.Duration) (*Server, error) {
	server, err := New(filepath.Join(dir, ".http-history"), ttl)
	if err != nil {
		return nil, err
	}
	server.store = store
	server.storeLeases = map[string]api.Lease{}
	server.timers = map[string]*time.Timer{}
	return server, nil
}

func (s *Server) closeStoreLease(id string) error {
	if t := s.timers[id]; t != nil {
		t.Stop()
		delete(s.timers, id)
	}
	if l := s.storeLeases[id]; l != nil {
		if err := l.Close(); err != nil {
			return err
		}
		delete(s.storeLeases, id)
	}
	return nil
}
func (s *Server) expireStoreLease(id string, h held) {
	if s.store == nil {
		return
	}
	if t := s.timers[id]; t != nil {
		t.Stop()
	}
	s.timers[id] = time.AfterFunc(time.Until(h.until), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.held[id] == h && !time.Now().Before(h.until) {
			if s.closeStoreLease(id) == nil {
				delete(s.held, id)
			}
		}
	})
}
func storeMetadata(s api.Session) (Session, error) {
	var m Session
	if len(s.HistoryMeta) > 0 {
		return m, json.Unmarshal(s.HistoryMeta, &m)
	}
	m.ID, m.Project, m.ParentSessionID = s.ID, s.Project, s.Parent
	if len(s.Entries) > 0 {
		m.Created = float64(s.Entries[0].Time.UnixMilli())
	}
	if source, entry, ok := strings.Cut(s.ForkedFrom, ":"); ok {
		m.ForkedFrom = &ForkOrigin{SessionID: source, EntryID: entry}
	}
	return m, nil
}
func (s *Server) loadStore(id string) (document, error) {
	// APIs used to serve history need a non-writer read. All SDK stores expose
	// it through List; using the open writer lease here would hide stale data
	// only from a subset of clients and could read under a fenced writer.
	all, err := s.store.List("")
	if err != nil {
		return document{}, err
	}
	for _, snap := range all {
		if snap.ID != id {
			continue
		}
		m, err := storeMetadata(snap)
		if err != nil {
			return document{}, err
		}
		d := document{Session: m, Entries: make([]json.RawMessage, 0, len(snap.Entries))}
		for _, e := range snap.Entries {
			d.Entries = append(d.Entries, portable.HistoryEntry(snap, e))
		}
		return d, nil
	}
	return document{}, os.ErrNotExist
}
func (s *Server) saveStore(d document, erasing bool) (err error) {
	id := d.Session.ID
	l := s.storeLeases[id]
	if l == nil {
		l, err = s.store.Acquire(id)
		if err != nil {
			return err
		}
		defer func() { err = errors.Join(err, l.Close()) }()
	}
	snap, err := l.Load()
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if snap.ID == "" {
		snap = api.Session{Version: 1, ID: id, Project: d.Session.Project, Parent: d.Session.ParentSessionID, HistoryMeta: raw(d.Session)}
		if o := d.Session.ForkedFrom; o != nil {
			snap.ForkedFrom = o.SessionID + ":" + o.EntryID
		}
	} else if len(snap.HistoryMeta) == 0 {
		snap.HistoryMeta = raw(d.Session)
	}
	snap.Entries = make([]api.Entry, 0, len(d.Entries))
	for _, row := range d.Entries {
		e, err := portable.ReadEntry(row)
		if err != nil {
			return err
		}
		e.Wire = row
		snap.Entries = append(snap.Entries, e)
	}
	if erasing {
		erase, ok := l.(interface{ SaveErasure(api.Session) error })
		if !ok {
			return errors.New("store lease lacks exact erasure")
		}
		return erase.SaveErasure(snap)
	}
	return l.Save(snap)
}
