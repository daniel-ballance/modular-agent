package local

import (
	"context"
	"errors"
	"modular/api"
	"time"
)

// ExitError keeps a command's nonzero exit distinct from losing the executor.
type ExitError struct {
	Code    int
	Message string
}

func (e *ExitError) Error() string { return e.Message }

func (e *Environment) Exec(ctx context.Context, cwd, command string, timeout time.Duration, progress func(string)) (api.ExecResult, error) {
	parent := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	output, err := e.Bash(ctx, cwd, command, progress)
	r := api.ExecResult{Output: output, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded)}
	if ctx.Err() != nil {
		if parent.Err() == nil && r.TimedOut {
			return r, nil
		}
		return r, ctx.Err()
	}
	code := 0
	var exit *ExitError
	if errors.As(err, &exit) {
		code = exit.Code
		err = nil
	}
	if err == nil {
		r.ExitCode = &code
	}
	return r, err
}
