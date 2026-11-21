package local

import (
	"os"
	"os/exec"
	"syscall"
)

func init() {
	if len(os.Args) == 2 && os.Args[1] == "--modular-command-supervisor" {
		superviseGroup()
		os.Exit(0)
	}
}

func (e *Environment) cleanup() error { return os.MkdirAll(e.root, 0700) }

func (e *Environment) startSupervisor(cmd *exec.Cmd) (func(), error) {
	// The watcher is the group leader, so the group ID cannot be reused
	// between the foreground exit and cleanup.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return func() {}, cmd.Start()
}
