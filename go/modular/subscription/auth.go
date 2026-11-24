// Package subscription implements shared sign-ins for subscription Providers.
package subscription

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
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
	Logins map[string]Login
	extra  map[string]json.RawMessage
}

type credentialsData struct {
	Answers map[string]string `json:"answers"`
	modular.CredentialStages
}

var credentialMembers = []string{"answers", "secretStages", "secretGenerations"}

func (data contents) credentials() (credentialsData, error) {
	fields := map[string]json.RawMessage{}
	for _, name := range credentialMembers {
		if value, ok := data.extra[name]; ok {
			fields[name] = value
		}
	}
	var out credentialsData
	b, err := json.Marshal(fields)
	if err != nil || json.Unmarshal(b, &out) != nil {
		return out, errors.New("the credential answers or staging data are invalid")
	}
	if out.Answers == nil {
		out.Answers = map[string]string{}
	}
	return out, nil
}

// Logins is a handle to the shared login file. Construct it with SubscriptionLogins.
type Logins struct {
	path string
}

// SubscriptionLogins names a login file without opening it.
func SubscriptionLogins(path string) Logins { return Logins{path: path} }

func privateFile(path string, flags int) (*os.File, error) {
	fd, err := unix.Open(path, flags|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(fd), path)
	stat, err := f.Stat()
	if err == nil && (!stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0) {
		err = fmt.Errorf("%s must be a regular file accessible only by its owner (mode 0600)", path)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func (a Logins) read() (contents, error) {
	data := contents{Logins: map[string]Login{}, extra: map[string]json.RawMessage{}}
	f, err := privateFile(a.path, unix.O_RDONLY)
	if os.IsNotExist(err) {
		return data, nil
	}
	if err != nil {
		return data, err
	}
	defer f.Close()
	invalid := func() error { return fmt.Errorf("%s is not a valid credential file", a.path) }
	b, err := io.ReadAll(f)
	if err != nil {
		return contents{}, err
	}
	if json.Unmarshal(b, &data.extra) != nil || data.extra == nil {
		return contents{}, invalid()
	}
	if logins, ok := data.extra["logins"]; ok {
		if json.Unmarshal(logins, &data.Logins) != nil || data.Logins == nil {
			return contents{}, invalid()
		}
		delete(data.extra, "logins")
	}
	for _, l := range data.Logins {
		if l.Type != "oauth" && l.Type != "api_key" {
			return contents{}, invalid()
		}
	}
	return data, nil
}
func (a Logins) CredentialStore() modular.TransactionalCredentials {
	return modular.TransactionalCredentials{
		Read: func(ctx context.Context, name string) (string, error) {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			data, err := a.read()
			if err != nil {
				return "", err
			}
			credentials, err := data.credentials()
			return credentials.Answers[name], err
		},
		Update: func(ctx context.Context, fn func(*modular.CredentialStages, map[string]string) (bool, error)) error {
			return a.locked(ctx, func(data contents) error {
				credentials, err := data.credentials()
				if err != nil {
					return err
				}
				save, err := fn(&credentials.CredentialStages, credentials.Answers)
				if err != nil || !save {
					return err
				}
				var fields map[string]json.RawMessage
				b, err := json.Marshal(credentials)
				if err != nil {
					return err
				}
				if err := json.Unmarshal(b, &fields); err != nil {
					return err
				}
				for _, name := range credentialMembers {
					delete(data.extra, name)
				}
				maps.Copy(data.extra, fields)
				return a.write(data)
			})
		},
	}
}

func (a Logins) Login(provider string) (*Login, error) {
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
func (a Logins) locked(ctx context.Context, run func(contents) error) error {
	dir := filepath.Dir(a.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	name := strings.TrimSuffix(a.path, filepath.Ext(a.path)) + ".lock"
	if name == a.path {
		return errors.New("the login file cannot have a .lock extension")
	}
	f, err := privateFile(name, unix.O_CREAT|unix.O_RDWR)
	if err != nil {
		return err
	}
	defer f.Close()
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
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
func (a Logins) write(data contents) error {
	// Match Rust's pretty JSON, sorted map keys, and no trailing newline.
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(withExtras(data)); err != nil {
		return err
	}
	dir := filepath.Dir(a.path)
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
	if err = os.Rename(f.Name(), a.path); err != nil {
		return err
	}
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

// Encode known keys in the standard configuration's order, followed by any
// other members in sorted order. Keep the latter as JSON, not Go values.
type withExtras contents

func (data withExtras) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	out.WriteString(`{"logins":`)
	if err := enc.Encode(data.Logins); err != nil {
		return nil, err
	}
	names := append(slices.Clone(credentialMembers), slices.Sorted(maps.Keys(data.extra))...)
	seen := map[string]bool{}
	for _, name := range names {
		v, ok := data.extra[name]
		if !ok || seen[name] {
			continue
		}
		seen[name] = true
		out.WriteByte(',')
		if err := enc.Encode(name); err != nil {
			return nil, err
		}
		out.WriteByte(':')
		out.Write(v)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

func (a Logins) Set(ctx context.Context, provider string, l *Login) error {
	return a.locked(ctx, func(data contents) error {
		if l == nil {
			delete(data.Logins, provider)
		} else {
			data.Logins[provider] = *l
		}
		return a.write(data)
	})
}
func (a Logins) Current(ctx context.Context, provider string, rejected *Login, refresh func(context.Context, Login) (Login, error)) (current Login, err error) {
	missing := func() error { return fmt.Errorf("not signed in to %s; sign in again", provider) }
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
