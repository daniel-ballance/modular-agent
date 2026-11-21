package codemode

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/files"
)

func assertNextRunWorks(t *testing.T) {
	t.Helper()
	out, err := run(t.Context(), "print('still here')\n6 * 7", nil, nil, StandardLimits())
	if err != nil || out.Status == modular.Failed || out.Content.Text() != "still here\n42" {
		t.Fatalf("next run: %+v, %v", out, err)
	}
}

func TestMemoryLimitDiscardsRun(t *testing.T) {
	out, err := run(t.Context(), `
print('before the limit')
print('x' * 60000)
x = []
for i in range(200000):
    x.append('y' * 10000)
print('finished allocation')
`, nil, nil, StandardLimits())
	if err != nil || out.Status != modular.Failed || !strings.Contains(out.Content.Text(), "MemoryError") ||
		!strings.Contains(out.Content.Text(), "before the limit") || strings.Contains(out.Content.Text(), "finished allocation") {
		t.Fatalf("memory limit: %+v, %v", out, err)
	}
	assertNextRunWorks(t)
}

func TestWorkerDiesOrIsCancelledDuringRun(t *testing.T) {
	for _, how := range []string{"death", "cancel"} {
		t.Run(how, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.CommandContext(ctx, exe, WorkerArg)
			req := runRequest{
				Code:   "tools.read('fixture')\nwhile True:\n    pass",
				Tools:  []modular.ToolDefinition{files.Tools("")[0].Definition()},
				Limits: StandardLimits(),
			}
			called := false
			out, err := runWorker(ctx, cmd, req, func(nestedCtx context.Context, _ string, _ any) (modular.ToolResult, error) {
				called = true
				if how == "death" {
					if err := cmd.Process.Kill(); err != nil {
						t.Fatal(err)
					}
				} else {
					cancel()
				}
				<-nestedCtx.Done()
				return modular.ToolResult{}, nestedCtx.Err()
			})
			if !called || cmd.ProcessState == nil || cmd.ProcessState.Success() {
				t.Fatalf("nested call reached: %t; worker state: %v", called, cmd.ProcessState)
			}
			if how == "death" {
				if err != nil || out.Status != modular.Failed || !strings.Contains(out.Content.Text(), "worker process died") {
					t.Fatalf("worker death: %+v, %v", out, err)
				}
			} else if !errors.Is(err, context.Canceled) {
				t.Fatalf("worker cancellation: %+v, %v", out, err)
			}
			assertNextRunWorks(t)
		})
	}
}
