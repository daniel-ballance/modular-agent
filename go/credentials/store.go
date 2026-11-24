package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"golang.org/x/sys/unix"
)

// Store binds the staging protocol to a file transaction.
type Store struct {
	Read   func(context.Context, string) (string, error)
	Update func(context.Context, func(*Stages, map[string]string) (bool, error)) error
}

func (s Store) Get(ctx context.Context, name string) (string, error) { return s.Read(ctx, name) }
func (s Store) Stage(ctx context.Context, session, request, name, actor, value string) (r api.SecretReceipt, err error) {
	err = s.Update(ctx, func(st *Stages, a map[string]string) (bool, error) {
		var e error
		r, e = st.Stage(a, session, request, name, actor, value)
		return e == nil, e
	})
	return
}
func (s Store) LookupStaged(ctx context.Context, session, request string) (r api.SecretReceipt, ok bool, err error) {
	err = s.Update(ctx, func(st *Stages, _ map[string]string) (bool, error) {
		r, ok = st.Lookup(session, request)
		return false, nil
	})
	return
}
func (s Store) Activate(ctx context.Context, r api.SecretReceipt) (d api.SecretDecision, err error) {
	err = s.Update(ctx, func(st *Stages, a map[string]string) (bool, error) {
		var e error
		d, e = st.Activate(a, r)
		return e == nil, e
	})
	return
}
func (s Store) Discard(ctx context.Context, session, request string) error {
	return s.Update(ctx, func(st *Stages, _ map[string]string) (bool, error) { st.Discard(session, request); return true, nil })
}

// JSONStore persists answers and their staging state in one private file.
func JSONStore(path string) Store {
	type data struct {
		Answers map[string]string `json:"answers"`
		Stages
	}
	read := func() (data, error) {
		v := data{Answers: map[string]string{}}
		fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		if errors.Is(err, unix.ENOENT) {
			return v, nil
		}
		if err != nil {
			return v, errors.New("credential file unavailable")
		}
		f := os.NewFile(uintptr(fd), path)
		defer f.Close()
		var info unix.Stat_t
		if err = unix.Fstat(fd, &info); err != nil || info.Mode&unix.S_IFMT != unix.S_IFREG || info.Mode&0077 != 0 || int(info.Uid) != os.Geteuid() {
			return v, errors.New("credential file must be private and owned by this user")
		}
		b, err := io.ReadAll(f)
		if err != nil {
			return v, errors.New("credential file unavailable")
		}
		v.Answers = nil
		if json.Unmarshal(b, &v) != nil || v.Answers == nil {
			return v, errors.New("invalid credential file")
		}
		return v, nil
	}
	return Store{
		Read: func(ctx context.Context, name string) (string, error) {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			v, e := read()
			return v.Answers[name], e
		},
		Update: func(ctx context.Context, fn func(*Stages, map[string]string) (bool, error)) error {
			if path == "" {
				return errors.New("credential path required")
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				return err
			}
			fd, err := unix.Open(path+".lock", unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_CREAT|unix.O_RDWR, 0600)
			if err != nil {
				return err
			}
			defer unix.Close(fd)
			for {
				if err := ctx.Err(); err != nil {
					return err
				}
				err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
				if err == nil {
					break
				}
				if err != unix.EWOULDBLOCK && err != unix.EINTR {
					return err
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(10 * time.Millisecond):
				}
			}
			v, err := read()
			if err != nil {
				return err
			}
			save, err := fn(&v.Stages, v.Answers)
			if err != nil || !save {
				return err
			}
			return saveJSON(path, v)
		},
	}
}

func saveJSON(path string, value any) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".credentials-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = json.NewEncoder(f).Encode(value); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
