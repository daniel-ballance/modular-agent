package modular

import (
	"context"
	"errors"
	"time"

	"github.com/OWNER/modular-agent/go/api"
)

// ToolEnvironment is the working environment scoped to one tool call. Relative
// paths resolve against Project. Calls cannot outlive the tool invocation.
type ToolEnvironment struct {
	tc      *ToolContext
	project string
	port    Environment
}

func (e ToolEnvironment) Project() string { return e.project }

func (e ToolEnvironment) work(ctx context.Context) (context.Context, func(), error) {
	if e.tc == nil || e.tc.settled.Load() {
		return nil, nil, &Error{Code: InvalidRequest, Message: "tool call has settled"}
	}
	if e.port == nil {
		return nil, nil, &Error{Code: NotSupported, Message: "no working environment"}
	}
	work, cancel := context.WithCancel(e.tc.ctx)
	stop := context.AfterFunc(ctx, cancel)
	if ctx.Err() != nil {
		cancel()
	}
	return work, func() { stop(); cancel() }, nil
}

func (e ToolEnvironment) Read(ctx context.Context, path string) ([]byte, error) {
	ctx, done, err := e.work(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	b, err := e.port.Read(ctx, e.project, path)
	return b, appError(err, Internal)
}
func (e ToolEnvironment) Write(ctx context.Context, path string, data []byte) error {
	ctx, done, err := e.work(ctx)
	if err != nil {
		return err
	}
	defer done()
	return appError(e.port.Write(ctx, e.project, path, data), Internal)
}
func (e ToolEnvironment) List(ctx context.Context, path string) ([]DirEntry, error) {
	ctx, done, err := e.work(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	l, ok := e.port.(api.DirectoryLister)
	if !ok {
		return nil, &Error{Code: NotSupported, Message: "environment does not list directories"}
	}
	entries, err := l.ListDir(ctx, e.project, path)
	if errors.Is(err, api.ErrListUnsupported) {
		return nil, &Error{Code: NotSupported, Message: err.Error()}
	}
	return entries, appError(err, Internal)
}
func (e ToolEnvironment) Exec(ctx context.Context, command string, timeout time.Duration, progress func(string)) (ExecResult, error) {
	ctx, done, err := e.work(ctx)
	if err != nil {
		return ExecResult{}, err
	}
	defer done()
	if progress == nil {
		progress = func(string) {}
	}
	executor, ok := e.port.(api.Executor)
	if !ok {
		return ExecResult{}, &Error{Code: NotSupported, Message: "environment does not provide structured command execution"}
	}
	result, err := executor.Exec(ctx, e.project, command, timeout, progress)
	return result, appError(err, Internal)
}
