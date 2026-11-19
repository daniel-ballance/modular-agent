package api

import (
	"context"
	"time"
)

type ExecResult struct {
	ExitCode *int   `json:"exitCode"`
	Output   string `json:"output"`
	TimedOut bool   `json:"timedOut"`
}

// Executor is the optional structured command result used by shared bindings.
type Executor interface {
	Exec(context.Context, string, string, time.Duration, func(string)) (ExecResult, error)
}
