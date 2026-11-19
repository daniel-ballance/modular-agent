package local

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// The helper runs before main, including in offline test executables. It has no
// Provider, credentials or agent state. Only the namespace's PID 1 may enter it.
func init() {
	if len(os.Args) != 2 || os.Args[1] != "--modular-command-supervisor" || os.Getpid() != 1 {
		return
	}
	supervise()
	os.Exit(0) // kernel namespace teardown also handles escaped/background children
}
func supervise() {
	// Linux capabilities are per-thread. Mount, drop, and fork on this thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	control := os.NewFile(3, "agent-lifetime")
	results := os.NewFile(4, "command-result")
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	var request commandRequest
	if err := json.NewDecoder(control).Decode(&request); err != nil {
		_ = json.NewEncoder(results).Encode(commandFrame{Error: "supervisor request: " + err.Error()})
		return
	}
	gone := make(chan struct{})
	// Decode can leave a trailing newline in the pipe. Only EOF means the
	// agent is gone, not a successful read of that framing byte.
	go func() { _, _ = io.Copy(io.Discard, control); close(gone) }()
	// /proc must describe this PID namespace, not the parent's. Bubblewrap
	// and other namespace-aware programs consult /proc/<getpid>/ns during setup.
	// The private mount namespace prevents changing the agent's /proc.
	// https://man7.org/linux/man-pages/man7/pid_namespaces.7.html
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		_ = json.NewEncoder(results).Encode(commandFrame{Error: "private mounts: " + err.Error()})
		return
	}
	if err := syscall.Mount("proc", "/proc", "proc", 0, ""); err != nil {
		_ = json.NewEncoder(results).Encode(commandFrame{Error: "namespace proc: " + err.Error()})
		return
	}
	// Clear effective, permitted, inheritable and (consequently) ambient
	// capabilities before executing untrusted commands.
	// https://man7.org/linux/man-pages/man2/capset.2.html
	caps := [2]unix.CapUserData{}
	if err := unix.Capset(&unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}, &caps[0]); err != nil {
		_ = json.NewEncoder(results).Encode(commandFrame{Error: "drop capabilities: " + err.Error()})
		return
	}
	cmd := exec.Command("bash", "-c", request.Command)
	cmd.Dir = request.Project
	// The wrapper forces os/exec to own the output pipes so WaitDelay can close
	// descriptors inherited by background descendants without waiting for them.
	// https://pkg.go.dev/os/exec#Cmd.WaitDelay
	encoder := json.NewEncoder(results)
	w := &commandOutput{encoder: encoder}
	cmd.Stdout = w
	cmd.Stderr = w
	cmd.WaitDelay = 100 * time.Millisecond
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		_ = json.NewEncoder(results).Encode(commandFrame{Error: err.Error()})
		return
	}
	go func() { done <- cmd.Wait() }()
	select {
	case <-gone:
		return
	case err := <-done:
		if errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState.Success() {
			err = nil
		}
		code := cmd.ProcessState.ExitCode()
		result := commandFrame{ExitCode: &code}
		if err != nil {
			result.Error = err.Error()
		}
		if encoder.Encode(result) != nil {
			return
		}
	}
	<-gone
}
