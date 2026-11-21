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
		// The kit's checks carry their own deadlines and fail fast; this bound only stops a hang.
		// A run takes about 80 s with this race-built binary on an idle machine, so a 150 s
		// budget failed beside other suites without anything being wrong.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
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
