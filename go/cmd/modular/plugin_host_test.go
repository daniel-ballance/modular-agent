package main_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestACPWithSplitStdioPlugins(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "modular")
	if b, err := exec.Command("go", "build", "-race", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	kit, _ := filepath.Abs("../../conformance/acp/run.mjs")
	runtimetest.Each(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "node", kit, "--verbose", "--plugin-checks", "--", binary, "--mode", "acp", "--runtime", runtimetest.Plugin(t).Name)
		cmd.Env = append(os.Environ(), "GORACE=atexit_sleep_ms=0", "MODULAR_AGENT_PLUGINS="+pluginSpecs(binary))
		cmd.WaitDelay = 5 * time.Second
		b, err := cmd.CombinedOutput()
		if err != nil || !allKitChecksPassed(b) || strings.Contains(string(b), "WARNING: DATA RACE") {
			t.Fatalf("split plugin ACP kit: %v\n%s", err, b)
		}
		t.Log(kitSummary(b))
	})
}
