package local_test

import (
	"context"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/local"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestFilePointsRestoreProjectAndBelongToTheEnvironment(t *testing.T) {
	ctx := api.WithExecution(context.Background(), api.Execution{Session: "saving-session"})
	project := t.TempDir()
	state := filepath.Join(project, "private", "agent")
	outside := filepath.Join(t.TempDir(), "outside")
	write := func(path, data string, mode fs.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), mode); err != nil {
			t.Fatal(err)
		}
	}
	assert := func(path, want string) {
		t.Helper()
		if data, err := os.ReadFile(path); err != nil || string(data) != want {
			t.Fatalf("%s: got %q, %v, want %q", path, data, err, want)
		}
	}
	env := local.NewAt(state)
	file := filepath.Join(project, "private", "script")
	link := filepath.Join(project, "link")
	write(file, "before", 0755)
	if err := os.Chmod(file, 0755); err != nil {
		t.Fatal(err)
	}
	write(outside, "outside before", 0600)
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	point, err := env.SavePoint(ctx, project)
	if err != nil || point == "" {
		t.Fatal(point, err)
	}
	if err = env.Close(); err != nil {
		t.Fatal(err)
	}
	write(outside, "outside later", 0600)
	write(filepath.Join(state, "keep"), "private state", 0600)
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(link); err != nil {
		t.Fatal(err)
	}
	write(link, "new file replacing link", 0600)
	added := filepath.Join(project, "added")
	write(added, "new", 0600)
	foreign := local.NewAt(t.TempDir())
	defer foreign.Close()
	if err = foreign.RestorePoint(ctx, project, point); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("foreign point: %v", err)
	}
	assert(added, "new")
	reopened := local.NewAt(state)
	defer reopened.Close()
	if err = reopened.RestorePoint(ctx, t.TempDir(), point); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("point from another project: %v", err)
	}
	if err = reopened.CheckPoint(ctx, project, point); err != nil {
		t.Fatal(err)
	}
	other := api.WithExecution(ctx, api.Execution{Session: "another-session"})
	if err = reopened.CheckPoint(other, project, point); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("foreign session point check: %v", err)
	}
	if err = reopened.RestorePoint(other, project, point); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("foreign session restore: %v", err)
	}
	assert(added, "new")
	if err = reopened.RestorePoint(ctx, project, point); err != nil {
		t.Fatal(err)
	}
	assert(file, "before")
	if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("restored mode: %v %v", info, err)
	}
	if target, err := os.Readlink(link); err != nil || target != outside {
		t.Fatalf("link: %s %v", target, err)
	}
	assert(outside, "outside later")
	assert(filepath.Join(state, "keep"), "private state")
	if _, err = os.Stat(added); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("new file was not removed: %v", err)
	}
}
