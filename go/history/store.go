// Package history stores immutable history trees in atomic JSON snapshots.
// Linux binding: flock serializes lease acquisition and atomic replacements.
// Sources: https://pkg.go.dev/syscall#Flock and https://pkg.go.dev/os#Rename
package history

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
)

var validID = regexp.MustCompile("^[a-zA-Z0-9_-]+$")

type Store struct {
	dir    string
	mu     sync.Mutex
	leases map[string]*lease
}
type lease struct {
	s      *Store
	id     string
	file   *os.File
	closed bool
	saved  *savedSnapshot
}

// A lease may reuse the verified prefix of its last successful save. Keep
// detached bytes so changes to a caller's snapshot cannot change the proof.
// Only use it if the on-disk file still matches, including after erasure.
type savedSnapshot struct {
	disk    []byte
	entries []savedEntry
}
type savedEntry struct {
	native []byte
	wire   json.RawMessage
}

func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, leases: map[string]*lease{}}
	return s, s.initPendingErasures()
}
func Plugin(dir string) api.Plugin {
	var s *Store
	return api.Plugin{Name: "history", Setup: func(a api.API) error {
		var err error
		s, err = New(dir)
		if err != nil {
			return err
		}
		return a.Provide("history", s)
	}}
}
func (s *Store) guard() (func(), error) {
	f, err := os.Open(s.dir)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

// WriterHeld probes the existing lock with a shared lock. It neither
// creates the lock file nor acquires the exclusive writer.
func (s *Store) WriterHeld(id string) (bool, error) {
	if !validID.MatchString(id) {
		return false, errors.New("invalid session identity")
	}
	// Serialize with Acquire and Close so this short-lived reader cannot
	// make a simultaneous writer fail its nonblocking lock attempt.
	unlock, err := s.guard()
	if err != nil {
		return false, err
	}
	defer unlock()
	f, err := os.Open(filepath.Join(s.dir, id+".lock"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	err = syscall.Flock(int(f.Fd()), syscall.LOCK_SH|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return true, nil
	}
	return false, err
}

func (s *Store) Acquire(id string) (api.Lease, error) {
	if !validID.MatchString(id) {
		return nil, errors.New("invalid session identity")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.guard()
	if err != nil {
		return nil, err
	}
	defer unlock()
	if _, ok := s.leases[id]; ok {
		return nil, errors.New("session already open")
	}
	f, err := os.OpenFile(filepath.Join(s.dir, id+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, errors.New("session held by another writer")
	}
	l := &lease{s: s, id: id, file: f}
	s.leases[id] = l
	return l, nil
}
func (l *lease) Close() error {
	s := l.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.closed {
		return nil
	}
	unlock, err := s.guard()
	if err != nil {
		return err
	}
	defer unlock()
	l.closed = true
	l.saved = nil
	delete(s.leases, l.id)
	// No waiter can acquire an old inode: acquisition/removal share the directory lock.
	err = os.Remove(filepath.Join(s.dir, l.id+".lock"))
	closeErr := l.file.Close()
	return errors.Join(err, closeErr)
}
func (s *Store) load(id string) (api.Session, error) {
	b, err := os.ReadFile(filepath.Join(s.dir, id+".json"))
	if err != nil {
		return api.Session{}, err
	}
	return decodeSnapshot(id, b)
}

func decodeSnapshot(id string, b []byte) (api.Session, error) {
	var disk snapshot
	if err := json.Unmarshal(b, &disk); err != nil {
		return api.Session{}, fmt.Errorf("history %s: %w", id, err)
	}
	snap := disk.Session
	if disk.Format != snapshotFormat || snap.Version != 1 || snap.ID != id || disk.Entries == nil || snap.Entries != nil {
		return api.Session{}, errors.New("unsupported or mismatched history snapshot")
	}
	for _, raw := range disk.Entries {
		e, err := portable.ReadEntry(raw)
		if err != nil {
			return api.Session{}, err
		}
		snap.Entries = append(snap.Entries, e)
	}
	snap = portable.Session(snap)
	if len(snap.HistoryMeta) != 0 {
		for i, entry := range snap.Entries {
			if entry.IsErased() && portable.ReadErased(disk.Entries[i]) {
				snap.Entries[i].Wire = disk.Entries[i]
			}
		}
	}
	return snap, nil
}

const snapshotFormat = "go-history/2"

type snapshot struct {
	Format  string            `json:"format"`
	Session api.Session       `json:"session"`
	Entries []json.RawMessage `json:"entries"`
}

func (l *lease) Load() (api.Session, error) {
	l.s.mu.Lock()
	defer l.s.mu.Unlock()
	if l.closed {
		return api.Session{}, errors.New("lease closed")
	}
	unlock, err := l.s.guard()
	if err != nil {
		return api.Session{}, err
	}
	defer unlock()
	return l.s.load(l.id)
}
func (l *lease) Save(snap api.Session) error {
	s := l.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.closed {
		return errors.New("lease closed")
	}
	unlock, err := s.guard()
	if err != nil {
		return err
	}
	defer unlock()
	if snap.ID != l.id || snap.Version != 1 {
		return errors.New("invalid snapshot")
	}
	disk, err := os.ReadFile(filepath.Join(s.dir, l.id+".json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var prefix []savedEntry
	if err == nil {
		if l.saved != nil && bytes.Equal(l.saved.disk, disk) {
			prefix = matchingPrefix(l.saved.entries, snap.Entries)
		}
		if prefix == nil {
			old, err := decodeSnapshot(l.id, disk)
			if err != nil {
				return err
			}
			if len(snap.Entries) < len(old.Entries) {
				return errors.New("history cannot shrink")
			}
			for i, e := range old.Entries {
				if !sameStoredEntry(old, snap, e, snap.Entries[i]) {
					return fmt.Errorf("history cannot change outside erasure: %s (%s)", e.ID, e.Kind)
				}
			}
		}
	}
	seen := make(map[string]bool, len(snap.Entries))
	wire := make([]json.RawMessage, len(snap.Entries))
	memo := make([]savedEntry, len(snap.Entries))
	copy(memo, prefix)
	cacheable := true
	for i, e := range snap.Entries {
		if e.ID == "" || seen[e.ID] {
			return errors.New("duplicate or empty entry identity")
		}
		seen[e.ID] = true
		if i < len(prefix) {
			wire[i] = prefix[i].wire
			continue
		}
		b := portable.HistoryEntry(snap, e)
		wire[i] = b
		// A journal entry can redact earlier records during a full fold. Do
		// not cache that case or any entry which changes when read back.
		if cacheable && stableEntry(snap.ID, e, b) {
			if native, err := json.Marshal(e); err == nil {
				memo[i] = savedEntry{native, b}
				continue
			}
		}
		cacheable = false
	}
	disk, err = s.writeSnapshot(snap, wire)
	if err != nil {
		return err
	}
	l.saved = nil
	if cacheable && len(memo) > 0 {
		l.saved = &savedSnapshot{disk, memo}
	}
	return nil
}

func matchingPrefix(saved []savedEntry, entries []api.Entry) []savedEntry {
	if len(entries) < len(saved) {
		return nil
	}
	for i, e := range saved {
		b, err := json.Marshal(entries[i])
		if err != nil || !bytes.Equal(e.native, b) {
			return nil
		}
	}
	return saved
}

func stableEntry(session string, e api.Entry, wire json.RawMessage) bool {
	loaded, err := portable.ReadEntry(wire)
	if err != nil || (loaded.Kind == "erasure" && !loaded.IsErased()) {
		return false
	}
	// Normalize exactly as loading a session does, apart from applying the
	// erasure journal, which already disqualifies the whole snapshot.
	snap := portable.Session(api.Session{ID: session, Entries: []api.Entry{loaded}})
	return portable.Same(snap.Entries[0], e)
}

func (s *Store) save(snap api.Session) error {
	entries := make([]json.RawMessage, len(snap.Entries))
	for i, e := range snap.Entries {
		entries[i] = portable.HistoryEntry(snap, e)
	}
	_, err := s.writeSnapshot(snap, entries)
	return err
}

func (s *Store) writeSnapshot(snap api.Session, entries []json.RawMessage) ([]byte, error) {
	snap.Entries = nil
	// Only store metadata that is outside the shared entry meanings here.
	snap.Settings, snap.Position, snap.Actors = api.Settings{}, "", nil
	b, err := json.Marshal(snapshot{snapshotFormat, snap, entries})
	if err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(s.dir, ".snapshot-")
	if err != nil {
		return nil, err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return nil, err
	}
	if err = os.Rename(name, filepath.Join(s.dir, snap.ID+".json")); err != nil {
		return nil, err
	}
	d, err := os.Open(s.dir)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	return b, d.Sync()
}
func (s *Store) list(project string) ([]api.Session, error) {
	files, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil {
		return nil, err
	}
	var out []api.Session
	for _, file := range files {
		id := filepath.Base(file)
		id = id[:len(id)-5]
		snap, err := s.load(id)
		if err != nil {
			return nil, err
		}
		if project == "" || snap.Project == project {
			out = append(out, snap)
		}
	}
	return out, nil
}
func (s *Store) List(project string) ([]api.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.guard()
	if err != nil {
		return nil, err
	}
	defer unlock()
	return s.list(project)
}
func (s *Store) Erase(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := s.guard()
	if err != nil {
		return err
	}
	defer unlock()
	all, err := s.list("")
	if err != nil {
		return err
	}
	var locks []*os.File
	defer func() {
		for _, f := range locks {
			_ = f.Close()
		}
	}()
	// Fail before changing anything if a session outside this store instance is held.
	for _, snap := range all {
		if s.leases[snap.ID] != nil {
			continue
		}
		f, err := os.OpenFile(filepath.Join(s.dir, snap.ID+".lock"), os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		locks = append(locks, f)
		if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			return errors.New("erasure refused: another writer holds a session")
		}
		defer os.Remove(filepath.Join(s.dir, snap.ID+".lock"))
	}
	erased := map[string]bool{}
	for _, id := range ids {
		erased[id] = true
	}
	kinds := map[string]string{}
	for _, snap := range all {
		for _, entry := range snap.Entries {
			if erased[entry.ID] && entry.AuthorityRecord() {
				return errors.New("authority records cannot be erased")
			}
			kinds[entry.ID] = entry.Kind
		}
	}
	for changed := true; changed; {
		changed = false
		// Intake and its model-visible input are aliases of one logical input.
		for _, snap := range all {
			for _, entry := range snap.Entries {
				if entry.Kind == "input" && erased[entry.ID] {
					for _, source := range entry.Copies {
						if (kinds[source] == "input.accepted" || kinds[source] == "input") && !erased[source] {
							erased[source] = true
							changed = true
						}
					}
				}
			}
		}
		for _, snap := range all {
			for _, e := range snap.Entries {
				if erased[e.ID] {
					continue
				}
				for _, source := range e.Copies {
					if erased[source] {
						erased[e.ID] = true
						changed = true
						break
					}
				}
			}
		}
	}
	for _, snap := range all {
		changed := false
		for i, e := range snap.Entries {
			if erased[e.ID] && !e.IsErased() && !e.AuthorityRecord() {
				snap.Entries[i] = e.Redacted()
				changed = true
			}
		}
		if changed {
			if err = s.save(snap); err != nil {
				return err
			}
		}
	}
	return nil
}
