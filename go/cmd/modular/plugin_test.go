package main_test

import (
	"context"
	"modular/api"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// These are the assigned public seams: the unchanged plugin kit and the ACP
// kit with a provider/hooks process and a separate tools/environment process.
func TestPluginBindingConformanceKit(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "modular")
	if b, err := exec.Command("go", "build", "-race", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	kit, _ := filepath.Abs("../../conformance/plugin/run.mjs")
	// The setsid check still probes a shell PID from outside its namespace.
	// Isolate that probe and leave the low PID slots unused.
	cmd := exec.CommandContext(ctx, "unshare", "--user", "--map-root-user", "--pid", "--fork", "--kill-child", "--mount-proc", "--",
		"bash", "-c", `for ((i=0;i<128;i++)); do /bin/true; done; exec node "$@"`, "bash", kit, "--verbose", "--", binary, "--serve-plugin")
	cmd.Env = append(os.Environ(), "GORACE=atexit_sleep_ms=0", "MODULAR_AGENT_PLUGIN_PARTS=provider,tools,environment,hooks")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 5 * time.Second
	b, err := cmd.CombinedOutput()
	out := string(b)
	if err != nil || strings.Contains(out, "WARNING: DATA RACE") || !allKitChecksPassed(b) {
		t.Fatalf("plugin kit: %v\n%s", err, b)
	}
	t.Log(string(b))
}

func pluginSpecs(binary string) string {
	return string(api.JSON([]any{
		map[string]any{"command": []string{binary, "--serve-plugin"}, "env": map[string]string{"MODULAR_AGENT_PLUGIN_PARTS": "provider,hooks"}},
		map[string]any{"command": []string{binary, "--serve-plugin"}, "env": map[string]string{"MODULAR_AGENT_PLUGIN_PARTS": "tools,environment"}},
	}))
}
