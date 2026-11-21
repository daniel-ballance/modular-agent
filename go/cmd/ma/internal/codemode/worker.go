package codemode

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

// WorkerArg is the private entry point used to re-execute ma.
const WorkerArg = "--codemode-worker"

// Each frame is a 4-byte big-endian length followed by one JSON value.
// Check the length before allocating, including when reading from the worker.
const maxFrame = 64 * 1024 * 1024

type runRequest struct {
	Code   string
	Tools  []modular.ToolDefinition
	Limits Limits
}

type callRequest struct {
	Name  string
	Input json.RawMessage
}

type callReply struct {
	Result modular.ToolResult
	Error  *string
}

type workerEvent struct {
	Call   *callRequest
	Output *modular.ToolOutput
	Error  *string
}

func readFrame(r io.Reader, value any) error {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > maxFrame {
		return fmt.Errorf("invalid frame length: %d bytes", n)
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func writeFrame(w io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > maxFrame {
		return fmt.Errorf("frame exceeds %d bytes", maxFrame)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// ServeWorker handles one run. Even a successful run never leaves a live
// interpreter behind for another request.
func ServeWorker(in io.Reader, out io.Writer) error {
	var req runRequest
	if err := readFrame(in, &req); err != nil {
		return err
	}
	fs, err := catalog(req.Tools)
	if err != nil {
		msg := err.Error()
		return writeFrame(out, workerEvent{Error: &msg})
	}
	// The parent cancels this run by killing the worker, including while a
	// native interpreter call is executing.
	result, err := evaluate(context.Background(), req.Code, fs, func(_ context.Context, name string, args any) (modular.ToolResult, error) {
		input, err := json.Marshal(args)
		if err != nil {
			return modular.ToolResult{}, err
		}
		if err := writeFrame(out, workerEvent{Call: &callRequest{Name: name, Input: input}}); err != nil {
			return modular.ToolResult{}, err
		}
		var reply callReply
		if err := readFrame(in, &reply); err != nil {
			return modular.ToolResult{}, err
		}
		if reply.Error != nil {
			return modular.ToolResult{}, errors.New(*reply.Error)
		}
		return reply.Result, nil
	}, req.Limits)
	if err != nil {
		msg := err.Error()
		return writeFrame(out, workerEvent{Error: &msg})
	}
	return writeFrame(out, workerEvent{Output: &result})
}

func run(ctx context.Context, code string, defs []modular.ToolDefinition, nested nestedFunc, limits Limits) (modular.ToolOutput, error) {
	exe, err := os.Executable()
	if err != nil {
		return modular.ToolOutput{}, err
	}
	cmd := exec.CommandContext(ctx, exe, WorkerArg)
	// The worker needs only the directories used to extract Monty's library.
	// In particular, it does not inherit the agent's provider keys.
	cmd.Env = []string{}
	for _, key := range []string{"HOME", "XDG_CACHE_HOME", "TMPDIR"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	return runWorker(ctx, cmd, runRequest{Code: code, Tools: defs, Limits: limits}, nested)
}

func runWorker(ctx context.Context, cmd *exec.Cmd, req runRequest, nested nestedFunc) (modular.ToolOutput, error) {
	var empty modular.ToolOutput
	in, err := cmd.StdinPipe()
	if err != nil {
		return empty, err
	}
	defer in.Close()
	// Own the read end so Wait can reap immediately, even while we read
	// buffered output or the worker is suspended in a nested call.
	out, childOut, err := os.Pipe()
	if err != nil {
		return empty, err
	}
	defer out.Close()
	cmd.Stdout = childOut
	err = cmd.Start()
	childOut.Close()
	if err != nil {
		return empty, fmt.Errorf("start codemode worker process: %w", err)
	}

	callbackCtx, cancel := context.WithCancel(ctx)
	exited := make(chan struct{})
	var exitErr error
	go func() {
		exitErr = cmd.Wait()
		cancel()
		close(exited)
	}()
	defer func() {
		_ = cmd.Process.Kill()
		<-exited
		cancel()
	}()

	failed := func(err error) (modular.ToolOutput, error) {
		if ctx.Err() != nil {
			return empty, ctx.Err()
		}
		msg := "codemode worker protocol: " + err.Error()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.EPIPE) || errors.Is(err, os.ErrClosed) {
			msg = "codemode worker process died during the run"
		}
		return modular.ToolOutput{Status: modular.Failed, Content: modular.Text(msg)}, nil
	}
	if err := writeFrame(in, req); err != nil {
		return failed(err)
	}
	allowed := make(map[string]bool, len(req.Tools))
	for _, def := range req.Tools {
		if def.Name != Name {
			allowed[def.Name] = true
		}
	}
	made := 0
	for {
		var event workerEvent
		if err := readFrame(out, &event); err != nil {
			return failed(err)
		}
		switch {
		case event.Call != nil && event.Output == nil && event.Error == nil:
			call := event.Call
			if !allowed[call.Name] || made >= req.Limits.Calls || len(call.Input) == 0 || call.Input[0] != '{' {
				return failed(errors.New("invalid nested call"))
			}
			if callbackCtx.Err() != nil {
				return failed(io.EOF)
			}
			made++
			result, err := nested(callbackCtx, call.Name, call.Input)
			if callbackCtx.Err() != nil {
				return failed(io.EOF)
			}
			reply := callReply{Result: result}
			if err != nil {
				msg := err.Error()
				reply.Error = &msg
			}
			if err := writeFrame(in, reply); err != nil {
				return failed(err)
			}
		case event.Call == nil && (event.Output == nil) != (event.Error == nil):
			<-exited
			if ctx.Err() != nil {
				return empty, ctx.Err()
			}
			if exitErr != nil {
				return failed(io.EOF)
			}
			if event.Error != nil {
				return empty, errors.New(*event.Error)
			}
			return *event.Output, nil
		default:
			return failed(errors.New("invalid worker event"))
		}
	}
}
