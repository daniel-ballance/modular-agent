package modular_test

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

// This backend uses its own snapshot format and no Go history internals.
type snapshotBackend struct {
	dir  string
	mu   sync.Mutex
	held map[string]bool
}
type snapshotLease struct {
	store *snapshotBackend
	id    string
}

func (b *snapshotBackend) Acquire(id string) (modular.HistoryLease, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.held[id] {
		return nil, &modular.Error{Code: modular.Held, Message: "held"}
	}
	b.held[id] = true
	return &snapshotLease{b, id}, nil
}
func (b *snapshotBackend) List(project string) ([]modular.SessionRecord, error) {
	files, err := os.ReadDir(b.dir)
	if err != nil {
		return nil, err
	}
	var out []modular.SessionRecord
	for _, f := range files {
		if filepath.Ext(f.Name()) != ".snapshot" {
			continue
		}
		s, err := (&snapshotLease{b, f.Name()[:len(f.Name())-len(".snapshot")]}).Load()
		if err != nil {
			return nil, err
		}
		if project == "" || s.Project == project {
			out = append(out, s)
		}
	}
	return out, nil
}
func (*snapshotBackend) Erase([]string) error { return errors.ErrUnsupported } // the service uses atomic exact erasure
func (l *snapshotLease) Load() (modular.SessionRecord, error) {
	var out modular.SessionRecord
	data, err := os.ReadFile(filepath.Join(l.store.dir, l.id+".snapshot"))
	if err == nil {
		err = json.Unmarshal(data, &out)
	}
	return out, err
}
func (l *snapshotLease) Save(s modular.SessionRecord) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(l.store.dir, "staging-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), filepath.Join(l.store.dir, l.id+".snapshot")); err != nil {
		return err
	}
	dir, err := os.Open(l.store.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}
func (l *snapshotLease) SaveErasure(s modular.SessionRecord) error { return l.Save(s) }
func (l *snapshotLease) Close() error {
	l.store.mu.Lock()
	defer l.store.mu.Unlock()
	delete(l.store.held, l.id)
	return nil
}

func TestCustomHistoryBackendPassesHistoryKit(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("history kit needs Node.js")
	}
	token := filepath.Join(t.TempDir(), "token")
	if err = os.WriteFile(token, []byte("offline-history-conformance-128bit"), 0600); err != nil {
		t.Fatal(err)
	}
	backend := &snapshotBackend{dir: t.TempDir(), held: map[string]bool{}}
	svc, err := modular.ListenHistory(t.Context(), modular.NewHistoryStore(backend, true, true), modular.HistoryOptions{Address: "127.0.0.1:0", TokenFile: token, StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := svc.Close(); err != nil {
			t.Error(err)
		}
	})
	out, err := exec.CommandContext(t.Context(), node, "../../conformance/history/run.mjs", svc.URL, token).CombinedOutput()
	result := regexp.MustCompile(`(?m)^39/39 checks passed$`).Find(out)
	if err != nil || result == nil {
		t.Fatalf("history kit: %v\n%s", err, out)
	}
	t.Log(string(result))
}
