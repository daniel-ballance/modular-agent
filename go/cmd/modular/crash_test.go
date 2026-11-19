package main_test

import (
	"bufio"
	"context"
	"encoding/json"
	"modular/api"
	"modular/fake"
	"modular/history"
	"modular/internal/proctest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestExecutableDurableSIGKILLResumeWithoutNewInput(t *testing.T) {
	proctest.Subreaper(t)
	root := t.TempDir()
	binary := filepath.Join(root, "modular")
	if b, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	script := func(name string, scripts ...fake.Script) string {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, api.JSON(scripts), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	firstScript := script("first.json", fake.Script{Response: api.Response{Stop: "tools", Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "interrupted", Name: "bash", Input: api.JSON(map[string]string{"command": "printf ready; sleep 60; printf wrong > must-not-exist"})}}}}})
	nextScript := script("next.json", fake.Script{Require: "outcome is unknown", Response: api.Response{Stop: "finished", Content: api.Text("resumed without new input")}})
	base := []string{"--runtime", "durable", "--state", filepath.Join(root, "history"), "--settings", filepath.Join(root, "absent")}
	first := exec.Command(binary, append(base, "--project", root, "--script", firstScript, "--mode", "json", "--prompt", "go")...)
	stdout, err := first.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = first.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	guardian := 0
	defer func() {
		if !waited {
			_ = first.Process.Kill()
			_ = first.Wait()
		}
		if guardian != 0 {
			_ = syscall.Kill(guardian, syscall.SIGKILL)
			proctest.Reap(t, guardian)
		}
	}()
	ready := make(chan api.Event, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var event api.Event
			if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Kind == "tool.progress" && strings.Contains(api.Decode[string](event.Data), "ready") {
				ready <- event
				return
			}
		}
	}()
	var event api.Event
	select {
	case event = <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("bash did not stream before crash")
	}
	files, _ := filepath.Glob(filepath.Join(root, "history", "commands", "*.json"))
	if len(files) != 1 {
		t.Fatal(files)
	}
	b, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	var owner struct{ Guardian struct{ PID int } }
	if err = json.Unmarshal(b, &owner); err != nil {
		t.Fatal(err)
	}
	guardian = owner.Guardian.PID
	if err = first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err = first.Wait(); err == nil {
		t.Fatal("agent not killed")
	}
	waited = true
	proctest.Reap(t, guardian)
	guardian = 0
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	second := exec.CommandContext(ctx, binary, append(base, "--session", event.Session, "--script", nextScript, "--mode", "print")...)
	output, err := second.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "resumed without new input") {
		t.Fatal(string(output), err)
	}
	store, err := history.New(filepath.Join(root, "history"))
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.Acquire(event.Session)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	snap, err := lease.Load()
	if err != nil {
		t.Fatal(err)
	}
	starts, ends, results := 0, 0, 0
	for _, e := range snap.Entries {
		switch e.Kind {
		case "turn.start":
			starts++
			if e.Turn != event.Turn {
				t.Fatal("new turn identity")
			}
		case "turn.end":
			ends++
		case "tool.result":
			results++
			if api.Decode[api.ToolResult](e.Data).Status != "unknown" {
				t.Fatal(e)
			}
		}
	}
	if starts != 1 || ends != 1 || results != 1 {
		t.Fatal(starts, ends, results)
	}
	if _, err = os.Stat(filepath.Join(root, "must-not-exist")); !os.IsNotExist(err) {
		t.Fatal("interrupted command repeated", err)
	}
}
