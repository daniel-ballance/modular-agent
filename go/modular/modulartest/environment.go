package modulartest

import (
	"context"
	"errors"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type MemoryEnv struct {
	mu       sync.RWMutex
	files    map[string][]byte
	commands map[string]ExecHandler
}
type ExecHandler func(context.Context, string, func(string)) (modular.ExecResult, error)

func MemoryEnvironment(files ...map[string][]byte) *MemoryEnv {
	e := &MemoryEnv{files: map[string][]byte{}, commands: map[string]ExecHandler{}}
	for _, f := range files {
		for name, b := range f {
			_ = e.Write(context.Background(), "/", name, b)
		}
	}
	return e
}
func (e *MemoryEnv) OnExec(name string, fn ExecHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.commands[name] = fn
}
func (*MemoryEnv) Close() error        { return nil }
func (*MemoryEnv) StopsOnCrash() bool  { return false }
func (*MemoryEnv) ConfinesFiles() bool { return true }
func (*MemoryEnv) Containment() string { return "none" }
func memoryPath(cwd, name string) (string, error) {
	if strings.ContainsRune(name, 0) || name == "" {
		return "", fs.ErrInvalid
	}
	if filepath.IsAbs(name) {
		rel, err := filepath.Rel(cwd, name)
		if err != nil {
			return "", fs.ErrInvalid
		}
		name = rel
	}
	name = path.Clean(name)
	if !filepath.IsLocal(name) {
		return "", fs.ErrPermission
	}
	return name, nil
}
func (e *MemoryEnv) Read(ctx context.Context, cwd, name string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	name, err := memoryPath(cwd, name)
	if err != nil {
		return nil, err
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	b, ok := e.files[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), b...), nil
}
func (e *MemoryEnv) Write(ctx context.Context, cwd, name string, b []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	name, err := memoryPath(cwd, name)
	if err != nil {
		return err
	}
	if name == "." {
		return fs.ErrInvalid
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for existing := range e.files {
		if strings.HasPrefix(existing, name+"/") || strings.HasPrefix(name, existing+"/") {
			return fs.ErrInvalid
		}
	}
	e.files[name] = append([]byte(nil), b...)
	return nil
}
func (e *MemoryEnv) ListDir(ctx context.Context, cwd, name string) ([]modular.DirEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	name, err := memoryPath(cwd, name)
	if err != nil {
		return nil, err
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	if _, ok := e.files[name]; ok {
		return nil, fs.ErrInvalid
	}
	prefix := ""
	if name != "." {
		prefix = name + "/"
	}
	found := map[string]string{}
	for f := range e.files {
		if rest, ok := strings.CutPrefix(f, prefix); ok {
			first, _, dir := strings.Cut(rest, "/")
			kind := "file"
			if dir {
				kind = "directory"
			}
			found[first] = kind
		}
	}
	if len(found) == 0 && name != "." {
		return nil, fs.ErrNotExist
	}
	out := make([]modular.DirEntry, 0, len(found))
	for n, k := range found {
		out = append(out, modular.DirEntry{Name: n, Kind: k})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
func (e *MemoryEnv) Bash(ctx context.Context, cwd, command string, progress func(string)) (string, error) {
	r, err := e.Exec(ctx, cwd, command, 0, progress)
	if err == nil && (r.ExitCode == nil || *r.ExitCode != 0) {
		err = errors.New("command did not exit successfully")
	}
	return r.Output, err
}
func (e *MemoryEnv) Exec(ctx context.Context, _ string, command string, timeout time.Duration, progress func(string)) (modular.ExecResult, error) {
	if err := ctx.Err(); err != nil {
		return modular.ExecResult{}, err
	}
	name, _, _ := strings.Cut(strings.TrimSpace(command), " ")
	e.mu.RLock()
	fn := e.commands[name]
	e.mu.RUnlock()
	if fn == nil {
		return modular.ExecResult{}, &modular.Error{Code: modular.NotSupported, Message: "no test command registered: " + name}
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	r, err := fn(ctx, command, progress)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		r.ExitCode = nil
		r.TimedOut = true
		return r, nil
	}
	if ctx.Err() != nil {
		return r, ctx.Err()
	}
	return r, err
}
