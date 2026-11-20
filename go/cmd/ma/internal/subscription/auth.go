// Package subscription implements the standard configuration's subscription Providers.
package subscription

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type Login struct {
	Type    string  `json:"type"`
	Access  string  `json:"access,omitempty"`
	Refresh string  `json:"refresh,omitempty"`
	Expires uint64  `json:"expires"`
	Account *string `json:"account,omitempty"`
	Key     string  `json:"key,omitempty"`
}

func (l Login) MarshalJSON() ([]byte, error) {
	switch l.Type {
	case "oauth":
		return json.Marshal(struct {
			Type    string  `json:"type"`
			Access  string  `json:"access"`
			Refresh string  `json:"refresh"`
			Expires uint64  `json:"expires"`
			Account *string `json:"account,omitempty"`
		}{l.Type, l.Access, l.Refresh, l.Expires, l.Account})
	case "api_key":
		return json.Marshal(struct {
			Type string `json:"type"`
			Key  string `json:"key"`
		}{l.Type, l.Key})
	default:
		return nil, errors.New("invalid credential type")
	}
}
func (l Login) Secret() string {
	if l.Type == "api_key" {
		return l.Key
	}
	return l.Access
}
func (l Login) Expired() bool {
	return l.Type == "oauth" && l.Expires <= uint64(time.Now().UnixMilli())
}

type contents struct {
	Logins  map[string]Login  `json:"logins"`
	Answers map[string]string `json:"answers"`
	modular.CredentialStages
}
type AuthFile string

func (a AuthFile) read() (contents, error) {
	data := contents{Logins: map[string]Login{}, Answers: map[string]string{}}
	b, err := os.ReadFile(string(a))
	if os.IsNotExist(err) {
		return data, nil
	}
	if err != nil {
		return data, err
	}
	invalid := func() error { return fmt.Errorf("%s is not a valid credential file", a) }
	if json.Unmarshal(b, &data) != nil || data.Logins == nil || data.Answers == nil {
		return contents{}, invalid()
	}
	for _, l := range data.Logins {
		if l.Type != "oauth" && l.Type != "api_key" {
			return contents{}, invalid()
		}
	}
	return data, nil
}
func (a AuthFile) CredentialStore() modular.TransactionalCredentials {
	return modular.TransactionalCredentials{
		Read: func(ctx context.Context, name string) (string, error) {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			data, err := a.read()
			return data.Answers[name], err
		},
		Update: func(ctx context.Context, fn func(*modular.CredentialStages, map[string]string) (bool, error)) error {
			return a.locked(ctx, func(data contents) error {
				save, err := fn(&data.CredentialStages, data.Answers)
				if err != nil || !save {
					return err
				}
				return a.write(data)
			})
		},
	}
}

func (a AuthFile) Login(provider string) (*Login, error) {
	data, err := a.read()
	if err != nil {
		return nil, err
	}
	l, ok := data.Logins[provider]
	if !ok {
		return nil, nil
	}
	return &l, nil
}
func (a AuthFile) locked(ctx context.Context, run func(contents) error) error {
	dir := filepath.Dir(string(a))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	name := filepath.Join(dir, "auth.lock")
	fd, err := unix.Open(name, unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_CREAT|unix.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EINTR) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	data, err := a.read()
	if err != nil {
		return err
	}
	return run(data)
}
func (a AuthFile) write(data contents) error {
	// Match Rust's pretty JSON, sorted map keys, and no trailing newline.
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		return err
	}
	dir := filepath.Dir(string(a))
	f, err := os.CreateTemp(dir, ".auth-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n"))); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), string(a)); err != nil {
		return err
	}
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}
func (a AuthFile) Set(ctx context.Context, provider string, l *Login) error {
	return a.locked(ctx, func(data contents) error {
		if l == nil {
			delete(data.Logins, provider)
		} else {
			data.Logins[provider] = *l
		}
		return a.write(data)
	})
}
func (a AuthFile) Current(ctx context.Context, provider string, rejected *Login, refresh func(context.Context, Login) (Login, error)) (current Login, err error) {
	missing := func() error { return fmt.Errorf("not signed in to %s; run `ma login %s`", provider, provider) }
	needs := func(l Login) bool {
		return l.Expired() || (rejected != nil && l.Type == "oauth" && l.Access == rejected.Access && l.Refresh == rejected.Refresh && l.Expires == rejected.Expires)
	}
	l, err := a.Login(provider)
	if err != nil {
		return current, err
	}
	if l == nil {
		return current, missing()
	}
	if !needs(*l) {
		return *l, nil
	}
	err = a.locked(ctx, func(data contents) error {
		var ok bool
		current, ok = data.Logins[provider]
		if !ok {
			return missing()
		}
		if !needs(current) {
			return nil
		}
		fresh, err := refresh(ctx, current)
		if err != nil {
			return err
		}
		current = fresh
		data.Logins[provider] = fresh
		return a.write(data)
	})
	return current, err
}
