package local

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"io/fs"
	"os"
	"syscall"
)

func (e *Environment) ListDir(ctx context.Context, project, name string) ([]api.DirEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var entries []fs.DirEntry
	var err error
	if e.confined {
		root, rel, err := confinedPath(project, name)
		if err != nil {
			return nil, errors.Join(fs.ErrInvalid, err)
		}
		defer root.Close()
		entries, err = fs.ReadDir(root.FS(), rel)
		if err != nil {
			return nil, directoryError(err)
		}
	} else {
		entries, err = os.ReadDir(path(project, name))
		if err != nil {
			return nil, directoryError(err)
		}
	}
	out := make([]api.DirEntry, 0, len(entries))
	for _, entry := range entries {
		kind := "other"
		if entry.IsDir() {
			kind = "directory"
		} else if entry.Type().IsRegular() {
			kind = "file"
		}
		out = append(out, api.DirEntry{Name: entry.Name(), Kind: kind})
	}
	return out, nil
}
func directoryError(err error) error {
	if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ELOOP) {
		return errors.Join(fs.ErrInvalid, err)
	}
	return err
}
