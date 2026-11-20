package local_test

import (
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/proctest"
	"github.com/daniel-ballance/modular-agent/go/local"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSIGKILLStopsForegroundEscapedAndBackgroundCommands(t *testing.T) {
	if root := os.Getenv("MODULAR_ENV_CRASH_ROOT"); root != "" {
		marker := os.Getenv("MODULAR_ENV_MARKER")
		command := "(exec -a " + marker + "-foreground sleep 60) & setsid bash -c 'exec -a " + marker + "-escaped sleep 60' &"
		if os.Getenv("MODULAR_ENV_BACKGROUND") != "1" {
			command += " wait"
		}
		p := fake.New(fake.Script{Response: api.Response{Stop: "tools", Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "bash", Name: "bash", Input: api.JSON(map[string]any{"command": command, "timeout_seconds": 60})}}}}}, fake.Script{Response: api.Response{Stop: "finished", Content: api.Text("background returned")}})
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Global: filepath.Join(root, "absent"), Model: "fake", Provider: p.Plugin()})
		if err != nil {
			t.Fatal(err)
		}
		id, err := h.API().New(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		_, err = h.API().Submit(context.Background(), id, api.Input{Content: api.Text("run")})
		if err != nil {
			t.Fatal(err)
		}
		out, err := h.API().Wait(context.Background(), id)
		if err != nil || out.Status != "completed" {
			t.Fatal(out, err)
		}
		if err = os.WriteFile(filepath.Join(root, "returned"), []byte("returned"), 0600); err != nil {
			t.Fatal(err)
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	proctest.Subreaper(t)
	for _, scenario := range []string{"foreground", "background", "supervisor-killed", "supervisor-stopped"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			marker := "modular-crash-" + api.ID()
			cmd := exec.Command(os.Args[0], "-test.run=^TestSIGKILLStopsForegroundEscapedAndBackgroundCommands$")
			cmd.Env = append(os.Environ(), "MODULAR_ENV_CRASH_ROOT="+root, "MODULAR_ENV_MARKER="+marker)
			if scenario == "background" {
				cmd.Env = append(cmd.Env, "MODULAR_ENV_BACKGROUND=1")
			}
			var stderr strings.Builder
			cmd.Stderr = &stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			guardian := 0
			waited := false
			defer func() {
				if !waited {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
				}
				if guardian != 0 {
					_ = syscall.Kill(guardian, syscall.SIGKILL)
					proctest.Reap(t, guardian)
				}
			}()
			proctest.Await(t, func() bool {
				return len(proctest.Find(marker+"-foreground")) == 1 && len(proctest.Find(marker+"-escaped")) == 1
			})
			pids := append(proctest.Find(marker+"-foreground"), proctest.Find(marker+"-escaped")...)
			files, _ := filepath.Glob(filepath.Join(root, "history", "commands", "*.json"))
			if len(files) != 1 {
				t.Fatal(files, stderr.String())
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
			if scenario == "background" {
				proctest.Await(t, func() bool { _, err := os.Stat(filepath.Join(root, "returned")); return err == nil })
			}
			if scenario == "supervisor-killed" {
				// Suspend the agent so it cannot remove the registry before its own crash.
				if err = syscall.Kill(cmd.Process.Pid, syscall.SIGSTOP); err != nil {
					t.Fatal(err)
				}
				if err = syscall.Kill(guardian, syscall.SIGKILL); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "supervisor-stopped" {
				if err = syscall.Kill(guardian, syscall.SIGSTOP); err != nil {
					t.Fatal(err)
				}
			}
			if err = cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err = cmd.Wait(); err == nil {
				t.Fatal("agent was not SIGKILLed")
			}
			waited = true
			if scenario == "supervisor-stopped" {
				for _, pid := range pids {
					if proctest.Gone(pid) {
						t.Fatal("test did not leave abandoned work for startup cleanup")
					}
				}
			}
			if scenario == "supervisor-stopped" || scenario == "supervisor-killed" {
				next := local.NewAt(filepath.Join(root, "history", "commands"))
				defer next.Close()
				if !next.StopsOnCrash() {
					t.Fatal("startup cleanup failed")
				}
				files, _ = filepath.Glob(filepath.Join(root, "history", "commands", "*.json"))
				if len(files) != 0 {
					t.Fatal("stale registry survived", files)
				}
			}
			for _, pid := range pids {
				proctest.Await(t, func() bool { return proctest.Gone(pid) })
			}
			proctest.Reap(t, guardian)
			for _, pid := range append(pids, guardian) {
				if err = syscall.Kill(pid, 0); err != syscall.ESRCH {
					t.Fatal("process survived or was not reaped", pid, err, stderr.String())
				}
			}
			guardian = 0
		})
	}
}
