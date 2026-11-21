//go:build linux || darwin

package local

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func superviseGroup() {
	control := os.NewFile(3, "agent-lifetime")
	results := os.NewFile(4, "command-result")
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	pid := os.Getpid()
	if pgid, err := syscall.Getpgid(pid); err != nil || pgid != pid {
		return
	}

	encoder := json.NewEncoder(results)
	var request commandRequest
	if err := json.NewDecoder(control).Decode(&request); err != nil {
		_ = encoder.Encode(commandFrame{Error: "supervisor request: " + err.Error()})
		return
	}
	gone := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, control); close(gone) }()
	cmd := exec.Command("bash", "-c", request.Command)
	cmd.Dir = request.Project
	w := &commandOutput{encoder: encoder}
	cmd.Stdout, cmd.Stderr = w, w
	cmd.WaitDelay = 100 * time.Millisecond
	if err := cmd.Start(); err != nil {
		_ = encoder.Encode(commandFrame{Error: err.Error()})
		return
	}
	// Install after starting bash so the command does not inherit an ignored TERM.
	signal.Ignore(syscall.SIGTERM)
	defer func() {
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		time.Sleep(250 * time.Millisecond)
		// The watcher is also killed, after signalling all remaining group members.
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}()
	done := make(chan error, 1)
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
