package local_test

import (
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/proctest"
	"github.com/daniel-ballance/modular-agent/go/local"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestSIGKILLStopsForegroundEscapedAndBackgroundCommands(t *testing.T) {
	if root := os.Getenv("MODULAR_ENV_CRASH_ROOT"); root != "" {
		marker := os.Getenv("MODULAR_ENV_MARKER")
		// Each marked process announces itself after exec. Use a separate pipe
		// for readiness: background commands can outlive the tool's output.
		command := "(exec -a " + marker + "-foreground bash -c 'printf F > crash-events; read -t 60 <> crash-hold') & " +
			"setsid bash -c 'exec -a " + marker + `-escaped bash -c "printf E > crash-events; read -t 60 <> crash-hold"' &`
		if os.Getenv("MODULAR_ENV_BACKGROUND") != "1" {
			command += " wait"
		}
		env := local.NewAt(filepath.Join(root, "commands"))
		defer env.Close()
		out, err := env.Exec(context.Background(), root, command, 60*time.Second, nil)
		if err != nil || out.ExitCode == nil || *out.ExitCode != 0 {
			t.Fatal(out, err)
		}
		if os.Getenv("MODULAR_ENV_BACKGROUND") == "1" {
			f, err := os.OpenFile(filepath.Join(root, "crash-events"), os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.WriteString("R"); err != nil {
				t.Fatal(err)
			}
			f.Close()
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	proctest.Subreaper(t)
	for _, scenario := range []string{"foreground", "background", "supervisor-killed", "supervisor-stopped"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			readyPath := filepath.Join(root, "crash-events")
			for _, path := range []string{readyPath, filepath.Join(root, "crash-hold")} {
				if err := unix.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Open both ends so the shell writers can come and go independently.
			ready, err := os.OpenFile(readyPath, os.O_RDWR|syscall.O_NONBLOCK, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer ready.Close()
			if err := ready.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
				t.Fatal(err)
			}
			marker := "modular-crash-" + api.ID()
			cmd := exec.Command(os.Args[0], "-test.run=^TestSIGKILLStopsForegroundEscapedAndBackgroundCommands$")
			cmd.Env = append(os.Environ(), "MODULAR_ENV_CRASH_ROOT="+root, "MODULAR_ENV_MARKER="+marker)
			if scenario == "background" {
				cmd.Env = append(cmd.Env, "MODULAR_ENV_BACKGROUND=1")
			}
			var stderr strings.Builder
			cmd.Stdout, cmd.Stderr = &stderr, &stderr
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
			want := map[byte]bool{'F': true, 'E': true}
			if scenario == "background" {
				want['R'] = true
			}
			for len(want) != 0 {
				var event [1]byte
				if _, err := io.ReadFull(ready, event[:]); err != nil {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
					waited = true
					t.Fatalf("waiting for readiness %v: %v\n%s", want, err, stderr.String())
				}
				if !want[event[0]] {
					t.Fatalf("unexpected readiness event %q", event[0])
				}
				delete(want, event[0])
			}
			var pids []int
			for _, suffix := range []string{"-foreground", "-escaped"} {
				found := proctest.Find(marker + suffix)
				if len(found) != 1 {
					t.Fatalf("expected one ready %s command, found %v", suffix, found)
				}
				pids = append(pids, found[0])
			}
			files, _ := filepath.Glob(filepath.Join(root, "commands", "*.json"))
			if len(files) != 1 {
				t.Fatalf("expected one command registry, found %v", files)
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
			if scenario == "supervisor-killed" {
				// Suspend the agent so it cannot remove the registry before its own crash.
				stopCrashProcess(t, cmd.Process.Pid)
				if err = syscall.Kill(guardian, syscall.SIGKILL); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "supervisor-stopped" {
				// Do not close the lifetime pipe until the supervisor has stopped.
				stopCrashProcess(t, guardian)
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
				next := local.NewAt(filepath.Join(root, "commands"))
				defer next.Close()
				if !next.StopsOnCrash() {
					t.Fatal("startup cleanup failed")
				}
				files, _ = filepath.Glob(filepath.Join(root, "commands", "*.json"))
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

func stopCrashProcess(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	stat := filepath.Join("/proc", strconv.Itoa(pid), "stat")
	proctest.Await(t, func() bool {
		data, err := os.ReadFile(stat)
		if err != nil {
			return false
		}
		info := string(data)
		return strings.HasPrefix(info[strings.LastIndexByte(info, ')')+1:], " T ")
	})
}
