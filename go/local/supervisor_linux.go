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
	encoder := json.NewEncoder(results)
	output, sender, err := os.Pipe()
	if err != nil {
		_ = encoder.Encode(commandFrame{Error: err.Error()})
		return
	}
	defer output.Close()
	cmd.Stdout, cmd.Stderr = sender, sender
	err = cmd.Start()
	_ = sender.Close()
	if err != nil {
		_ = encoder.Encode(commandFrame{Error: err.Error()})
		return
	}
	waited := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		// Wake the reader at foreground exit, even if a background process
		// still holds the pipe open. This is a signal, not an output deadline.
		waited <- errors.Join(err, output.SetReadDeadline(time.Now()))
	}()
	done := make(chan error, 1)
	go func() {
		err := drainCommandOutput(output, &commandOutput{encoder: encoder})
		done <- errors.Join(<-waited, err)
	}()
	select {
	case <-gone:
		return
	case err := <-done:
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

func drainCommandOutput(output *os.File, destination io.Writer) error {
	if _, err := io.Copy(destination, output); !errors.Is(err, os.ErrDeadlineExceeded) {
		return err
	}
	// All foreground bytes are in the pipe or have already been forwarded.
	// Drain the current buffer without waiting for descendants to close it
	// or allowing ongoing background writes to keep this call running.
	raw, err := output.SyscallConn()
	if err != nil {
		return err
	}
	var pending int
	var ioctlErr error
	if err = raw.Control(func(fd uintptr) {
		pending, ioctlErr = unix.IoctlGetInt(int(fd), unix.TIOCINQ)
	}); err != nil || ioctlErr != nil {
		return errors.Join(err, ioctlErr)
	}
	if err := output.SetReadDeadline(time.Time{}); err != nil {
		return err
	}
	_, err = io.CopyN(destination, output, int64(pending))
	return err
}
