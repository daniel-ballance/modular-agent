package api

import (
	"context"
	"errors"
)

var ErrListUnsupported = errors.New("environment does not list directories")

type DirEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type DirectoryLister interface {
	ListDir(context.Context, string, string) ([]DirEntry, error)
}
