package codemode

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"google.golang.org/protobuf/proto"
)

const workerVersion = "1.6.0"
const protocolVersion = 8
const oomExitCode = 65 // monty-types resource.rs at v1.6.0
const openingTimeout = 5 * time.Second

var errCompute = errors.New("TimeoutError: sandbox time limit exceeded")

type printLimitError int

func (e printLimitError) Error() string {
	return fmt.Sprintf("RuntimeError: printed output exceeded %d bytes", int(e))
}

type versionOutput struct{ strings.Builder }

func (v *versionOutput) Write(p []byte) (int, error) {
	if v.Len()+len(p) > 128 {
		return 0, errors.New("oversized version response")
	}
	return v.Builder.Write(p)
}

func workerCommand(ctx context.Context, path string) (*exec.Cmd, error) {
	checkCtx, cancel := context.WithTimeout(ctx, openingTimeout)
	defer cancel()
	check := command(checkCtx, path, "--version")
	check.WaitDelay = openingTimeout
	var version versionOutput
	check.Stdout = &version
	if err := check.Run(); err != nil {
		return nil, fmt.Errorf("cannot run Monty %s worker at %s: %w", workerVersion, path, err)
	}
	if strings.TrimSpace(version.String()) != "monty-runtime "+workerVersion {
		return nil, fmt.Errorf("wrong Monty worker at %s: need %s (protocol %d), got %q", path, workerVersion, protocolVersion, strings.TrimSpace(version.String()))
	}
	return command(ctx, path, "subprocess"), nil
}

func command(ctx context.Context, path string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = []string{} // No provider keys, user settings or PATH.
	workerLifetime(cmd)
	return cmd
}

func run(ctx context.Context, code string, defs []modular.ToolDefinition, nested nestedFunc, limits Limits) (modular.ToolOutput, error) {
	exe, err := os.Executable()
	if err != nil {
		return modular.ToolOutput{}, err
	}
	return runAt(ctx, filepath.Join(filepath.Dir(exe), "monty"), code, defs, nested, limits)
}

func runAt(ctx context.Context, path, code string, defs []modular.ToolDefinition, nested nestedFunc, limits Limits) (modular.ToolOutput, error) {
	cmd, err := workerCommand(ctx, path)
	if err != nil {
		if ctx.Err() != nil {
			return modular.ToolOutput{}, ctx.Err()
		}
		return failedOutput(fmt.Errorf("%w; build it with go/scripts/build-monty.sh and put it beside ma", err), ""), nil
	}
	return runWorker(ctx, cmd, code, defs, nested, limits)
}

type worker struct {
	in, out *os.File
	ctx     context.Context
	exited  chan struct{}
	exitErr error // read only after exited closes
}

func runWorker(ctx context.Context, cmd *exec.Cmd, code string, defs []modular.ToolDefinition, nested nestedFunc, limits Limits) (modular.ToolOutput, error) {
	fs, err := catalog(defs)
	if err != nil {
		return modular.ToolOutput{}, err
	}
	// Own both host pipe ends so Wait can reap promptly without closing
	// them while we read a buffered final event or wait on a nested tool.
	childIn, in, err := os.Pipe()
	if err != nil {
		return modular.ToolOutput{}, err
	}
	defer in.Close()
	out, childOut, err := os.Pipe()
	if err != nil {
		childIn.Close()
		return modular.ToolOutput{}, err
	}
	defer out.Close()
	cmd.Stdin, cmd.Stdout = childIn, childOut
	err = cmd.Start()
	childIn.Close()
	childOut.Close()
	if err != nil {
		if ctx.Err() != nil {
			return modular.ToolOutput{}, ctx.Err()
		}
		return failedOutput(fmt.Errorf("start codemode worker process: %w", err), ""), nil
	}
	callCtx, cancel := context.WithCancel(ctx)
	w := &worker{in: in, out: out, ctx: callCtx, exited: make(chan struct{})}
	go func() {
		w.exitErr = cmd.Wait()
		close(w.exited)
		cancel()
	}()
	defer func() {
		cancel()
		_ = cmd.Process.Kill()
		<-w.exited
	}()

	var printed strings.Builder
	value, made, err := w.drive(code, fs, nested, limits, &printed, w.exchange)
	if ctx.Err() != nil {
		return modular.ToolOutput{}, ctx.Err()
	}
	if err != nil {
		return failedOutput(err, printed.String()), nil
	}
	return renderOutput(value, made, printed.String()), nil
}

func (w *worker) exchange(req *pb.ClientRequest, timeout time.Duration, printed *strings.Builder, printCap int) (*pb.WorkerEvent, error) {
	deadline := time.Now().Add(timeout)
	if err := w.in.SetWriteDeadline(deadline); err != nil {
		return nil, err
	}
	if err := w.out.SetReadDeadline(deadline); err != nil {
		return nil, err
	}
	if err := writeFrame(w.in, req); err != nil {
		return nil, w.ioError(err)
	}
	for {
		if time.Now().After(deadline) {
			return nil, errCompute
		}
		event, err := readEvent(w.out)
		if err != nil {
			return nil, w.ioError(err)
		}
		switch e := event.Kind.(type) {
		case *pb.WorkerEvent_Print:
			if printed == nil || len(e.Print.Segments) == 0 {
				return nil, protocolError("unexpected print event")
			}
			for _, seg := range e.Print.Segments {
				if seg.Stream != pb.PrintStream_PRINT_STREAM_STDOUT && seg.Stream != pb.PrintStream_PRINT_STREAM_STDERR {
					return nil, protocolError("invalid print stream")
				}
				left := printCap - printed.Len()
				if len(seg.Text) > left {
					printed.WriteString(utf8Prefix(seg.Text, left))
					return nil, printLimitError(printCap)
				}
				printed.WriteString(seg.Text)
			}
		case *pb.WorkerEvent_FatalError:
			return nil, protocolError("worker fatal error: %s", e.FatalError.Message)
		default:
			return event, nil
		}
	}
}

func protocolError(s string, args ...any) error {
	return fmt.Errorf("codemode worker protocol: %s", fmt.Sprintf(s, args...))
}

func (w *worker) ioError(err error) error {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return errCompute
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.EPIPE) {
		// Let Wait classify a real exit instead of racing an allocator abort
		// with SIGKILL. A broken worker that only closed its pipes is bounded.
		select {
		case <-w.exited:
			var exit *exec.ExitError
			if errors.As(w.exitErr, &exit) && exit.ExitCode() == oomExitCode {
				return errors.New("MemoryError: sandbox worker exceeded its memory limit")
			}
		case <-w.ctx.Done():
		case <-time.After(openingTimeout):
		}
		return errors.New("codemode worker process died during the run (closed its protocol pipe)")
	}
	return protocolError("%v", err)
}

func configuration(l Limits) *pb.ClientRequest {
	return &pb.ClientRequest{Kind: &pb.ClientRequest_Configure{Configure: &pb.Configure{
		ProtocolVersion: protocolVersion, MontyVersion: workerVersion,
		ExecutionClock: pb.ExecutionClock_WALL.Enum(),
		Limits: &pb.ResourceLimits{
			MaxMemoryBytes: proto.Uint64(256 << 20), MaxRecursionDepth: proto.Uint64(uint64(l.Recursion)),
			MaxTurnDurationMicros: proto.Uint64(uint64(l.Compute.Microseconds())),
		},
		OsPolicy: &pb.OsPolicy{
			Datetime:    &pb.OsPolicy_CallHost{CallHost: &pb.Unit{}},
			Sleep:       &pb.SleepMode{Mode: &pb.SleepMode_CallHost{CallHost: &pb.Unit{}}},
			RandomStart: &pb.OsPolicy_RandomCallHost{RandomCallHost: &pb.Unit{}},
			ProcessTime: &pb.OsPolicy_Zero{Zero: &pb.Unit{}},
		},
	}}}
}
