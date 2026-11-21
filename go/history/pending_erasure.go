package history

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"github.com/daniel-ballance/modular-agent/go/api"
)

const pendingLock = ".pending-erasure.lock"
const pendingRegistry = ".pending-erasure"

func (s *Store) initPendingErasures() error {
	unlock, err := s.guard()
	if err != nil {
		return err
	}
	defer unlock()
	lock, err := os.OpenFile(filepath.Join(s.dir, pendingLock), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer lock.Close()
	if _, err := os.Stat(filepath.Join(s.dir, pendingRegistry)); errors.Is(err, os.ErrNotExist) {
		return s.writePendingErasures([]byte("[]"))
	} else {
		return err
	}
}

// PendingErasures uses a separate lock from the snapshot directory lock:
// an intent transaction may read history or save under an existing lease.
func (s *Store) PendingErasures(fn func(*[]api.ErasureIntent) error) error {
	f, err := os.OpenFile(filepath.Join(s.dir, pendingLock), os.O_RDWR, 0)
	if err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	defer f.Close()
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	b, err := os.ReadFile(filepath.Join(s.dir, pendingRegistry))
	if err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	var intents []api.ErasureIntent
	if err := json.Unmarshal(b, &intents); err != nil || intents == nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	for _, intent := range intents {
		if intent.ID == "" || intent.Source == "" || len(intent.Targets) == 0 || len(intent.Copies) == 0 {
			return api.ErrErasureUnavailable
		}
		for _, copy := range intent.Copies {
			if copy.SessionID == "" || copy.ID == "" {
				return api.ErrErasureUnavailable
			}
		}
	}
	if err = fn(&intents); err != nil {
		return err
	}
	next, err := json.Marshal(intents)
	if err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	if bytes.Equal(b, next) {
		return nil
	}
	if err := s.writePendingErasures(next); err != nil {
		return errors.Join(api.ErrErasureUnavailable, err)
	}
	return nil
}

func (s *Store) writePendingErasures(b []byte) error {
	f, err := os.CreateTemp(s.dir, ".pending-erasure-stage-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if err = errors.Join(err, f.Close()); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), filepath.Join(s.dir, pendingRegistry)); err != nil {
		return err
	}
	d, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
