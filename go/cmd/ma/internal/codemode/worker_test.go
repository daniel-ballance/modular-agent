package codemode

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/files"
)

func assertNextRunWorks(t *testing.T) {
	t.Helper()
	out, err := testRun(t, "print('still here')\n6 * 7", nil, nil, StandardLimits())
	if err != nil || out.Status == modular.Failed || out.Content.Text() != "still here\n42" {
		t.Fatalf("next run: %+v, %v", out, err)
	}
}

func TestMemoryLimitDiscardsRun(t *testing.T) {
	out, err := testRun(t, `
print('before the limit')
print('x' * 60000)
x = []
try:
    for i in range(200000):
        x.append('y' * 10000)
except MemoryError:
    print('caught the limit')
print('finished allocation')
`, nil, nil, StandardLimits())
	if err != nil || out.Status != modular.Failed || !strings.Contains(out.Content.Text(), "MemoryError") ||
		!strings.Contains(out.Content.Text(), "before the limit") || strings.Contains(out.Content.Text(), "finished allocation") ||
		strings.Contains(out.Content.Text(), "caught the limit") {
		t.Fatalf("memory limit: %+v, %v", out, err)
	}
	assertNextRunWorks(t)
}

func TestWorkerDiesOrIsCancelledDuringRun(t *testing.T) {
	for _, how := range []string{"death", "cancel"} {
		t.Run(how, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			cmd := command(ctx, testWorker(t), "subprocess")
			called := make(chan struct{})
			code := "tools.read('fixture')\nwhile True:\n    pass"
			defs := []modular.ToolDefinition{files.Tools("")[0].Definition()}
			out, err := runWorker(ctx, cmd, code, defs, func(nestedCtx context.Context, _ string, _ any) (modular.ToolResult, error) {
				close(called)
				if how == "death" {
					if err := cmd.Process.Kill(); err != nil {
						t.Error(err)
					}
				} else {
					cancel()
				}
				<-nestedCtx.Done()
				return modular.ToolResult{}, nestedCtx.Err()
			}, StandardLimits())
			select {
			case <-called:
			default:
				t.Fatal("nested call not reached")
			}
			if cmd.ProcessState == nil || cmd.ProcessState.Success() {
				t.Fatalf("worker was not killed and reaped: %v", cmd.ProcessState)
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
