package credentials

import (
	"context"
	"errors"
	"os"
)

func (f *File) Put(ctx context.Context, name, value string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if name == "" || name == "anthropic" || f.Path == "" {
		return errors.New("credential destination unavailable or reserved")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	dir := f.Path + ".d"
	if err := os.MkdirAll(dir, 0700); err != nil {
		return errors.New("credential store unavailable")
	}
	file, err := os.CreateTemp(dir, ".secret-")
	if err != nil {
		return errors.New("credential store unavailable")
	}
	defer os.Remove(file.Name())
	_, err = file.WriteString(value)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), f.secretPath(name))
	}
	if err == nil {
		d, e := os.Open(dir)
		if e == nil {
			err = d.Sync()
			_ = d.Close()
		} else {
			err = e
		}
	}
	if err != nil {
		return errors.New("credential write failed")
	}
	return nil
}
