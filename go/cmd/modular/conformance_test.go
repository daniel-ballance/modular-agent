package main_test

import (
	"context"
	"modular/api"
	"modular/historyhttp"
	"modular/internal/runtimetest"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestACPBindingConformanceKit(t *testing.T) {
	kit, err := filepath.Abs("../../conformance/acp")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(kit, "node_modules/@agentclientprotocol/sdk/package.json")); err != nil {
		t.Fatal("install the offline test prerequisite first: cd conformance/acp && npm ci")
	}
	binary := filepath.Join(t.TempDir(), "modular")
	if b, err := exec.Command("go", "build", "-race", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	runtimetest.Each(t, func(t *testing.T) {
		runACPCrashKit(t, kit, binary, runtimetest.Plugin(t).Name, "")
	})
	t.Run("external-durable", func(t *testing.T) {
		spec := string(api.JSON([]any{map[string]any{"command": []string{binary, "--serve-plugin"}, "env": map[string]string{"MODULAR_AGENT_PLUGIN_PARTS": "durable-runtime"}}}))
		runACPCrashKit(t, kit, binary, "transient", spec)
	})
}

func runACPCrashKit(t *testing.T, kit, binary, runtime, specs string) {
	t.Helper()
	// This is the whole-kit watchdog, not the deadline for any wire check.
	// The growing kit runs against a race-instrumented executable.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "run.mjs", "--verbose", "--crash-checks", "--", binary, "--mode", "acp", "--runtime", runtime)
	cmd.Env = append(os.Environ(), "GORACE=atexit_sleep_ms=0", "MODULAR_AGENT_PLUGINS="+specs)
	cmd.Dir = kit
	cmd.WaitDelay = 5 * time.Second
	b, err := cmd.CombinedOutput()
	if err != nil || !allKitChecksPassed(b) || strings.Contains(string(b), "WARNING: DATA RACE") {
		t.Fatalf("ACP kit: %v\n%s", err, b)
	}
	if (runtime == "durable" || specs != "") && !strings.Contains(string(b), "with continuesAfterRestart, the turn carried on and completed") {
		t.Fatalf("ACP kit did not exercise durable recovery\n%s", b)
	}
	t.Log(kitSummary(b))
}

func TestCommandUsesSharedHistoryEnvironment(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "modular")
	if b, err := exec.Command("go", "build", "-race", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	s, err := historyhttp.New(t.TempDir(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s.Handler("history-test-token-123"))
	defer ts.Close()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("history-test-token-123"), 0600); err != nil {
		t.Fatal(err)
	}
	data, project := t.TempDir(), t.TempDir()
	invoke := func(url, tokenFile string, extra ...string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		args := []string{"--mode", "print", "--project", project, "--prompt", "hello", "--key", "shared-key"}
		cmd := exec.CommandContext(ctx, binary, append(args, extra...)...)
		cmd.Env = append(os.Environ(), "MODULAR_AGENT_CONFORMANCE=1", "MODULAR_AGENT_DATA_DIR="+data,
			"MODULAR_AGENT_HISTORY_URL="+url, "MODULAR_AGENT_HISTORY_TOKEN_FILE="+tokenFile)
		b, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatal(string(b), err)
		}
		return string(b)
	}
	first := invoke(ts.URL, token)
	match := regexp.MustCompile(`session: ([a-f0-9]+)`).FindStringSubmatch(first)
	if len(match) != 2 || !strings.Contains(first, "echo: hello") {
		t.Fatal(first)
	}
	// Explicit flags remain available and override the matching environment variables.
	if again := invoke("invalid-url", filepath.Join(data, "missing-token"),
		"--history-url", ts.URL, "--history-token-file", token, "--session", match[1]); !strings.Contains(again, "Already accepted:") {
		t.Fatal(again)
	}
}

func TestConformanceDataDirectoryAndNoGateway(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "modular")
	if b, err := exec.Command("go", "build", "-race", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	data, project, outside := t.TempDir(), t.TempDir(), t.TempDir()
	// These external configuration files must not affect isolated execution.
	if err := os.MkdirAll(filepath.Join(project, ".modular-agent"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".modular-agent/settings.json"), []byte(`{"model":"unavailable"}`), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "--mode", "print", "--prompt", "hello", "--project", project, "--state", filepath.Join(outside, "history"), "--settings", filepath.Join(outside, "settings.json"), "--model-gateway", "http://127.0.0.1:1", "--service-token-file", filepath.Join(outside, "missing-token"))
	cmd.Env = append(os.Environ(), "MODULAR_AGENT_CONFORMANCE=1", "MODULAR_AGENT_DATA_DIR="+data)
	b, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(b), "echo: hello") {
		t.Fatal(string(b), err)
	}
	files, err := os.ReadDir(outside)
	if err != nil || len(files) != 0 {
		t.Fatal("state escaped data directory", files, err)
	}
	files, err = os.ReadDir(filepath.Join(data, "history"))
	if err != nil || len(files) == 0 {
		t.Fatal("history not isolated", err)
	}
}
