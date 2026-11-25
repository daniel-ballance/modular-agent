package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The operating system follows b/alias to a/sub before "..", so
// b/alias/.. is a, not b. filepath.Abs alone would clean it to b.
func TestCanonicalFollowsSymlinksBeforeDotDot(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"a/sub", "b"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "a", "sub"), filepath.Join(root, "b", "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "a", "sub"), filepath.Join(root, "b", "relative")); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	want := filepath.Join(root, "a")
	for _, p := range []string{"b/alias/..", "b/relative/..", root + "/b/alias/..", "./b/alias/../sub/.."} {
		got, err := canonical(p)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		if got != want {
			t.Errorf("canonical(%q) = %q, want %q", p, got, want)
		}
	}
	if got, err := canonical("."); err != nil || got != root {
		t.Errorf("canonical(.) = %q, %v", got, err)
	}
}
