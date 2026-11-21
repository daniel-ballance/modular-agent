package codemode

import "os/exec"

// Monty's subprocess transport exits when the agent's stdin pipe closes.
func workerLifetime(*exec.Cmd) {}
