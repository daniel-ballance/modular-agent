package codemode

import (
	"os/exec"
	"syscall"
)

func workerLifetime(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
