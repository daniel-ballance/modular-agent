package credentials_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/credentials"
	"os"
	"path/filepath"
	"testing"
)

func TestNamedSecretsPersistPrivatelyAndCannotReplaceExperimentKey(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "anthropic.key")
	if err := os.WriteFile(path, []byte("fake-key"), 0600); err != nil {
		t.Fatal(err)
	}
	store := &credentials.File{Path: path}
	ctx := context.Background()
	if err := store.Put(ctx, "../arbitrary/name", "first"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "../arbitrary/name", "second"); err != nil {
		t.Fatal(err)
	}
	reopened := &credentials.File{Path: path}
	v, err := reopened.Get(ctx, "../arbitrary/name")
	if err != nil || v != "second" {
		t.Fatal(v, err)
	}
	if err = store.Put(ctx, "anthropic", "must not write"); err == nil {
		t.Fatal("experiment key replaced")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "fake-key" {
		t.Fatal("experiment key changed")
	}
	info, _ := os.Stat(path + ".d")
	if info.Mode().Perm() != 0700 {
		t.Fatal(info.Mode())
	}
	files, _ := os.ReadDir(path + ".d")
	if len(files) != 1 {
		t.Fatal(files)
	}
	info, _ = files[0].Info()
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
}
