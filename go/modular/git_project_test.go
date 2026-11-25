package modular_test

import (
	"os/exec"
	"testing"
)

func gitProject(t *testing.T) string {
	t.Helper()
	project := t.TempDir()
	if out, err := exec.CommandContext(t.Context(), "git", "init", "-q", project).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	return project
}
