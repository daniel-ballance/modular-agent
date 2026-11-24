// Package credentials reads the experiment key only when the Provider asks.
// The Runtime's turn ports do not expose this capability.
package credentials

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"os"
	"strings"
)

type File struct {
	Path string
}

func (f *File) CanStore(name string) bool { return f.Path != "" && name != "" && name != "anthropic" }

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
		if err == nil && value == "" {
			err = errors.New("credential not found")
		}
		return value, err
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
