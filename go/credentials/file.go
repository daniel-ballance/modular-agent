// Package credentials reads the experiment key only when the Provider asks.
// The Runtime's turn ports do not expose this capability.
package credentials

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"os"
	"path/filepath"
	"strings"
)

type File struct {
	Path string
}

func (f *File) CanStore(name string) bool { return f.Path != "" && name != "" && name != "anthropic" }
func (f *File) secretPath(name string) string {
	return filepath.Join(f.Path+".d", fmt.Sprintf("%x", sha256.Sum256([]byte(name))))
}

func Plugin(path string) api.Plugin {
	return api.Plugin{Name: "credentials", Setup: func(a api.API) error { return a.Provide("credentials", &File{Path: path}) }}
}
func (f *File) Get(ctx context.Context, name string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if name != "anthropic" {
		if f.Path == "" {
			return "", errors.New("credential store unavailable")
		}
		value, err := f.answers().Get(ctx, name)
		if err != nil || value != "" {
			return value, err
		}
		// A previous build kept named answers as separate private files.
		b, err := os.ReadFile(f.secretPath(name))
		if err != nil {
			return "", errors.New("credential not found")
		}
		return string(b), nil
	}
	b, err := os.ReadFile(f.Path)
	if err != nil {
		return "", errors.New("credential file unavailable")
	}
	key := strings.TrimSpace(string(b))
	if key == "" {
		return "", errors.New("credential file empty")
	}
	return key, nil
}
