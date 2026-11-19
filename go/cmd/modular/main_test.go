package main_test

import (
	"bytes"
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestExecutableContinuesSessionInNewProcessWithOriginalProject(t *testing.T) {
	runtimetest.Each(t, testExecutableContinuesSessionInNewProcessWithOriginalProject)
}
func testExecutableContinuesSessionInNewProcessWithOriginalProject(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "modular")
	build := exec.Command("go", "build", "-o", bin, ".")
	if b, err := build.CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	project, other, state := filepath.Join(dir, "project"), filepath.Join(dir, "other"), filepath.Join(dir, "history")
	for _, p := range []string{project, other} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(project, "fact.txt"), []byte("42"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "fact.txt"), []byte("wrong-project"), 0600); err != nil {
		t.Fatal(err)
	}
	script := func(name string, scripts []fake.Script) string {
		path := filepath.Join(dir, name)
		b, err := json.Marshal(scripts)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	firstScript := script("first.json", []fake.Script{
		{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "read-first", Name: "read", Input: api.JSON(map[string]string{"path": "fact.txt"})}}}, Stop: "tools"}},
		{Require: "42", Response: api.Response{Content: api.Text("The file says 42."), Stop: "finished"}},
	})
	secondScript := script("second.json", []fake.Script{
		{Require: "The file says 42.", Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "read-again", Name: "read", Input: api.JSON(map[string]string{"path": "fact.txt"})}}}, Stop: "tools"}},
		{Require: "42", Response: api.Response{Content: api.Text("Continued: 42."), Stop: "finished"}},
	})
	invoke := func(args ...string) (string, string) {
		t.Helper()
		cmd := exec.Command(bin, append([]string{"--runtime", runtimetest.Plugin(t).Name, "--state", state, "--settings", filepath.Join(dir, "absent-settings")}, args...)...)
		var out, stderr bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			t.Fatal(err, stderr.String())
		}
		return out.String(), stderr.String()
	}
	out, stderr := invoke("--project", project, "--script", firstScript, "--mode", "print", "--prompt", "Read fact.txt", "--key", "first-key")
	if out != "The file says 42.\n" {
		t.Fatal(out)
	}
	match := regexp.MustCompile(`session: ([a-f0-9]+)`).FindStringSubmatch(stderr)
	if len(match) != 2 {
		t.Fatal(stderr)
	}
	id := match[1]
	out, _ = invoke("--project", other, "--session", id, "--script", secondScript, "--mode", "print", "--prompt", "Continue from the earlier answer")
	if out != "Continued: 42.\n" {
		t.Fatal(out)
	}
	empty := script("empty.json", []fake.Script{})
	out, _ = invoke("--session", id, "--script", empty, "--mode", "print", "--prompt", "retry", "--key", "first-key")
	if !strings.Contains(out, "Already accepted:") {
		t.Fatal(out)
	}
	out, _ = invoke("--session", id, "--script", empty, "--mode", "print", "--prompt", "/history")
	var snap api.Session
	if err := json.Unmarshal([]byte(out), &snap); err != nil {
		t.Fatal(err, out)
	}
	if snap.Project != project {
		t.Fatal(snap.Project)
	}
	turns := 0
	for _, e := range snap.Entries {
		if e.Kind == "turn.start" {
			turns++
		}
	}
	if turns != 2 {
		t.Fatal(turns)
	}
}
