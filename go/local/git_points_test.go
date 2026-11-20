package local_test

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/local"
)

func git(t *testing.T, top string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", top, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s (%v)", args, out, err)
	}
	return strings.TrimSpace(string(out))
}

func writeGitFile(t *testing.T, top, name, text string) {
	t.Helper()
	path := filepath.Join(top, name)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func readGitFile(t *testing.T, top, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(top, name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func gitPointFixture(t *testing.T) (string, string, *local.Environment, context.Context) {
	t.Helper()
	top, state := t.TempDir(), t.TempDir()
	git(t, top, "init", "-q")
	writeGitFile(t, top, ".gitignore", "target/\n")
	writeGitFile(t, top, "tracked.txt", "one\n")
	git(t, top, "add", "-A")
	git(t, top, "commit", "-qm", "first")
	writeGitFile(t, top, "staged.txt", "staged\n")
	git(t, top, "add", "staged.txt")
	writeGitFile(t, top, "notes/untracked.txt", "draft\n")
	writeGitFile(t, top, "target/build.bin", "old build\n")
	env := local.NewGitAt(state)
	t.Cleanup(func() { _ = env.Close() })
	return top, state, env, api.WithExecution(t.Context(), api.Execution{Session: "s1"})
}

func saveGitPoint(t *testing.T, ctx context.Context, env *local.Environment, project string) string {
	t.Helper()
	point, err := env.SavePoint(ctx, project)
	if err != nil || point == "" {
		t.Fatalf("save: %q, %v", point, err)
	}
	return point
}

func TestGitPointsOutsideGit(t *testing.T) {
	env, project := local.NewGitAt(t.TempDir()), t.TempDir()
	defer env.Close()
	ctx := api.WithExecution(t.Context(), api.Execution{Session: "s1"})
	if env.KeepsPoints(project) {
		t.Fatal("non-Git project keeps points")
	}
	if _, err := env.SavePoint(ctx, project); err == nil {
		t.Fatal("saved outside Git")
	}
	if err := env.CheckPoint(ctx, project, "p1"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
}

func TestGitPointsRestoreLeavesGitAndIgnoredFilesAlone(t *testing.T) {
	top, _, env, ctx := gitPointFixture(t)
	if !env.KeepsPoints(top) {
		t.Fatal("Git project does not keep points")
	}
	head, index := git(t, top, "rev-parse", "HEAD"), readGitFile(t, top, ".git/index")
	point := saveGitPoint(t, ctx, env, top)
	writeGitFile(t, top, "tracked.txt", "changed\n")
	if err := os.Remove(filepath.Join(top, "notes/untracked.txt")); err != nil {
		t.Fatal(err)
	}
	writeGitFile(t, top, "new/created.txt", "new\n")
	writeGitFile(t, top, "target/build.bin", "new build\n")
	if err := env.RestorePoint(ctx, top, point); err != nil {
		t.Fatal(err)
	}
	for file, want := range map[string]string{"tracked.txt": "one\n", "staged.txt": "staged\n", "notes/untracked.txt": "draft\n", "target/build.bin": "new build\n"} {
		if got := string(readGitFile(t, top, file)); got != want {
			t.Errorf("%s: got %q, want %q", file, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(top, "new")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("added path not removed: %v", err)
	}
	if git(t, top, "rev-parse", "HEAD") != head || git(t, top, "rev-list", "--count", "HEAD") != "1" || !bytes.Equal(readGitFile(t, top, ".git/index"), index) {
		t.Fatal("restore modified HEAD, branch or index")
	}
	if git(t, top, "for-each-ref", "refs/modular-agent/recovery/") != "" {
		t.Fatal("recovery ref remains after success")
	}
}

func TestGitPointsSubfolder(t *testing.T) {
	top, _, env, ctx := gitPointFixture(t)
	project := filepath.Join(top, "notes")
	point := saveGitPoint(t, ctx, env, project)
	if got := git(t, top, "ls-tree", "-r", "--name-only", "refs/modular-agent/points/s1/"+point); got != "notes/untracked.txt" {
		t.Fatalf("unexpected files in point: %s", got)
	}
	writeGitFile(t, project, "untracked.txt", "changed\n")
	writeGitFile(t, top, "tracked.txt", "outside change\n")
	if err := env.RestorePoint(ctx, project, point); err != nil {
		t.Fatal(err)
	}
	if string(readGitFile(t, project, "untracked.txt")) != "draft\n" || string(readGitFile(t, top, "tracked.txt")) != "outside change\n" {
		t.Fatal("restore did not stay within the project")
	}
}

func TestGitPointsOwnershipAndGC(t *testing.T) {
	top, state, env, ctx := gitPointFixture(t)
	point := saveGitPoint(t, ctx, env, top)
	git(t, top, "gc", "-q", "--prune=now")
	if err := env.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := local.NewGitAt(state)
	defer reopened.Close()
	if err := reopened.CheckPoint(ctx, top, point); err != nil {
		t.Fatal(err)
	}
	foreign := api.WithExecution(ctx, api.Execution{Session: "s2"})
	for _, err := range []error{reopened.CheckPoint(foreign, top, point), reopened.CheckPoint(ctx, filepath.Join(top, "notes"), point), reopened.CheckPoint(ctx, top, "no-such-point")} {
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("unexpected check result: %v", err)
		}
	}
	bad := api.WithExecution(ctx, api.Execution{Session: "../escape"})
	if _, err := reopened.SavePoint(bad, top); err == nil {
		t.Fatal("saved a point with an invalid session ID")
	}
}

func TestGitPointsProjectHoldingState(t *testing.T) {
	top, _, _, ctx := gitPointFixture(t)
	env := local.NewGitAt(filepath.Join(top, "state"))
	defer env.Close()
	if env.KeepsPoints(top) {
		t.Fatal("project containing agent state keeps points")
	}
	if _, err := env.SavePoint(ctx, top); err == nil {
		t.Fatal("saved a point containing agent state")
	}
}

func TestGitPointsRollBackWhenIgnoredPathBlocksRestore(t *testing.T) {
	top, _, env, ctx := gitPointFixture(t)
	point := saveGitPoint(t, ctx, env, top)
	writeGitFile(t, top, ".gitignore", "target/\nnotes/\n")
	writeGitFile(t, top, "notes/untracked.txt", "now ignored\n")
	writeGitFile(t, top, "new/created.txt", "new\n")
	if err := env.RestorePoint(ctx, top, point); err == nil || !strings.Contains(err.Error(), "cannot restore over") {
		t.Fatalf("expected blocked restore: %v", err)
	}
	if string(readGitFile(t, top, "notes/untracked.txt")) != "now ignored\n" || string(readGitFile(t, top, "new/created.txt")) != "new\n" {
		t.Fatal("failed restore truncated the project")
	}
	if git(t, top, "for-each-ref", "refs/modular-agent/recovery/") != "" {
		t.Fatal("recovery ref remains after successful rollback")
	}
}
