package modular_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type servedCrashRuntime struct {
	checkpointRuntime
	readyAddress string
}

func (r servedCrashRuntime) RunTurn(ctx context.Context, turn modular.RuntimeInput, cx *modular.RuntimeContext) (modular.TurnOutcome, error) {
	if r.readyAddress == "" {
		return modular.TurnOutcome{}, errors.New("reopening must call ResumeTurn, not RunTurn")
	}
	out, err := r.demoRuntime.RunTurn(ctx, turn, cx)
	if err != nil {
		return out, err
	}
	// Both the response and its step.after decision were acknowledged by the
	// host. Keep the connection open so the parent can also observe our death.
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", r.readyAddress)
	if err != nil {
		return out, err
	}
	defer conn.Close()
	if err := json.NewEncoder(conn).Encode(turn.TurnID); err != nil {
		return out, err
	}
	<-ctx.Done()
	return modular.TurnOutcome{}, ctx.Err()
}

type servedLateRuntime struct{ demoRuntime }

func (servedLateRuntime) RunTurn(ctx context.Context, _ modular.RuntimeInput, cx *modular.RuntimeContext) (out modular.TurnOutcome, err error) {
	step, err := cx.NewID(ctx)
	if err != nil {
		return out, err
	}
	req, err := cx.PrepareStep(ctx, step, modular.Usage{})
	if err != nil {
		return out, err
	}
	msg, err := cx.Model(ctx, step, req)
	if err != nil {
		return out, err
	}
	row, err := cx.Record(ctx, modular.HistoryEntry{"kind": "response", "stepId": step, "message": msg})
	if err != nil {
		return out, err
	}
	if len(msg.Content) != 1 || msg.Content[0].Type != "toolCall" {
		return out, fmt.Errorf("unexpected model reply: %+v", msg)
	}
	part := msg.Content[0]
	var call modular.ToolCall
	if err := json.Unmarshal(part.Fields["id"], &call.ID); err != nil {
		return out, err
	}
	if err := json.Unmarshal(part.Fields["name"], &call.Name); err != nil {
		return out, err
	}
	call.Input = part.Fields["arguments"]
	gate, err := cx.Hook(ctx, "tool.before", modular.HookPayload{"call": call})
	if err != nil {
		return out, err
	}
	if pending, _ := gate["pending"].(string); pending == "" {
		return out, fmt.Errorf("call did not stay open: %+v", gate)
	}
	if _, err := cx.Hook(ctx, "step.after", modular.HookPayload{"stepId": step, "response": msg}); err != nil {
		return out, err
	}
	return modular.TurnOutcome{Outcome: modular.Outcome{Kind: "completed"},
		Result: modular.TurnResult{OpenToolCalls: []string{call.ID}}, Entries: []string{row["id"].(string)}, Usage: msg.Usage}, nil
}

func (servedLateRuntime) ContinueOpenCalls(ctx context.Context, turn modular.RuntimeInput, calls []modular.PendingCall, cx *modular.RuntimeContext) (modular.TurnOutcome, error) {
	if turn.StartedBy.Kind != "answer" || turn.StartedBy.ID == "" || len(calls) != 1 ||
		calls[0].ID == "" || calls[0].Name != "confirm" || calls[0].StepID == "" {
		return modular.TurnOutcome{}, fmt.Errorf("unexpected continuity: %+v, calls %+v", turn, calls)
	}
	call := calls[0]
	toolCall := modular.ToolCall{ID: call.ID, Name: call.Name, Input: call.Input}
	gate, err := cx.Hook(ctx, "tool.before", modular.HookPayload{"call": toolCall})
	if err != nil || gate["refused"] != nil || gate["pending"] != nil {
		return modular.TurnOutcome{}, fmt.Errorf("continued gate: %+v, %v", gate, err)
	}
	result, err := cx.RunToolCall(ctx, toolCall)
	if err != nil {
		return modular.TurnOutcome{}, err
	}
	if result.Pending != "" || result.Status != modular.Completed || result.CallID != call.ID {
		return modular.TurnOutcome{}, fmt.Errorf("unexpected continued result: %+v", result)
	}
	return modular.TurnOutcome{Outcome: modular.Outcome{Kind: "completed"},
		Result: modular.TurnResult{Text: "continued: " + result.Text()}}, nil
}

func servedTestRuntime(t *testing.T, kind, ready string) modular.Option {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return modular.WithProcessPlugin(modular.ProcessPlugin{
		Command: []string{exe, "-test.run=^TestServedRuntimeProgram$"},
		Env:     map[string]string{"MA_TEST_RUNTIME_PROGRAM": kind},
		Config:  map[string]any{"ready": ready},
	})
}

func TestServedRuntimeProgram(t *testing.T) {
	kind := os.Getenv("MA_TEST_RUNTIME_PROGRAM")
	if kind == "" {
		t.Skip("only run in the plugin child")
	}
	p := modular.Plugin{Name: "developer-runtime", Replaces: []string{"runtime"}, Setup: func(r *modular.Registrar) error {
		var runtime modular.RuntimeImplementation
		switch kind {
		case "crash":
			ready, _ := r.Config()["ready"].(string)
			runtime = servedCrashRuntime{readyAddress: ready}
		case "late":
			runtime = servedLateRuntime{}
		default:
			return fmt.Errorf("unknown fixture %s", kind)
		}
		return r.Runtime(modular.NewRuntime(runtime))
	}}
	if err := modular.Serve(t.Context(), p); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0) // stdout belongs to the binding, not the test runner.
}

func crashRuntimeOptions(project, data string) []modular.Option {
	return []modular.Option{modular.WithProject(project), modular.WithDataDir(data), modular.WithDurability(modular.Durable),
		modulartest.Script(`[{"text":"committed before the crash"}]`)}
}

type crashTraceProcessor struct{ path string }

func (p crashTraceProcessor) OnStart(ctx context.Context, s sdktrace.ReadWriteSpan) {
	if s.Name() == "invoke_agent" {
		_ = os.WriteFile(p.path, []byte(telemetry.Inject(trace.ContextWithSpan(ctx, s)).Parent), 0600)
	}
}
func (crashTraceProcessor) OnEnd(sdktrace.ReadOnlySpan)      {}
func (crashTraceProcessor) Shutdown(context.Context) error   { return nil }
func (crashTraceProcessor) ForceFlush(context.Context) error { return nil }

func TestServedRuntimeCrashHostProgram(t *testing.T) {
	ready := os.Getenv("MA_TEST_RUNTIME_CRASH_READY")
	if ready == "" {
		t.Skip("only run in the host child")
	}
	ctx := t.Context()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(crashTraceProcessor{filepath.Join(os.Getenv("MA_TEST_DATA"), "crash-trace")})))
	options := append(crashRuntimeOptions(os.Getenv("MA_TEST_PROJECT"), os.Getenv("MA_TEST_DATA")), servedTestRuntime(t, "crash", ready))
	a, err := modular.New(ctx, options...)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(ctx)
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(os.Stdout, s.ID())
	if _, err = s.Prompt(ctx, "interrupted prompt"); err != nil {
		t.Fatal(err)
	}
	t.Fatal("fixture returned without a crash")
}

func TestServedCustomRuntimeRecoversAfterProcessCrash(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := listener.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	project, data := t.TempDir(), t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, exe, "-test.run=^TestServedRuntimeCrashHostProgram$")
	cmd.Env = append(os.Environ(), "MA_TEST_RUNTIME_CRASH_READY="+listener.Addr().String(), "MA_TEST_PROJECT="+project, "MA_TEST_DATA="+data)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var reaped bool
	defer func() {
		if !reaped {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_ = cmd.Wait()
		}
	}()
	lines := bufio.NewScanner(stdout)
	if !lines.Scan() {
		t.Fatalf("host did not announce session ID: %v", lines.Err())
	}
	id := lines.Text()
	ready, err := listener.Accept()
	if err != nil {
		t.Fatalf("served Runtime did not reach the checkpoint: %v", err)
	}
	defer ready.Close()
	if err := ready.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	var turnID string
	decoder := json.NewDecoder(ready)
	if err := decoder.Decode(&turnID); err != nil || turnID == "" {
		t.Fatalf("no turn at crash checkpoint: %q, %v", turnID, err)
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	var exit *exec.ExitError
	err = cmd.Wait()
	reaped = true
	if !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
		t.Fatalf("host did not die by SIGKILL: %v", err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		t.Fatalf("old Runtime did not exit: %v", err)
	}

	wire, err := os.ReadFile(filepath.Join(data, "crash-trace"))
	if err != nil {
		t.Fatal(err)
	}
	previous := telemetry.Parse(&telemetry.Wire{Parent: string(wire)})
	if !previous.IsValid() {
		t.Fatal("missing original turn span context")
	}
	mem := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(mem))
	otel.SetTracerProvider(tp)
	defer otel.SetTracerProvider(tracenoop.NewTracerProvider())
	defer tp.Shutdown(context.Background())
	options := append(crashRuntimeOptions(project, data), servedTestRuntime(t, "crash", ""))
	a := modulartest.Agent(t, options...)
	s, err := a.OpenSession(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.LastTurn(ctx)
	if err != nil || got == nil || got.Outcome == nil || got.Outcome.Kind != "completed" ||
		got.TurnID != turnID || got.Text != "recovered committed step" {
		t.Fatalf("recovered turn: %+v, %v", got, err)
	}
	history, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var resumed bool
	for _, span := range mem.GetSpans() {
		if span.Name != "invoke_agent" {
			continue
		}
		resumed = true
		if span.Parent.SpanID() != previous.SpanID() || span.SpanContext.SpanID() == previous.SpanID() || span.SpanContext.TraceID() != previous.TraceID() ||
			len(span.Links) != 1 || span.Links[0].SpanContext.SpanID() != previous.SpanID() {
			t.Fatalf("wrong resumed trace parent or link: %+v", span)
		}
	}
	if !resumed {
		t.Fatal("no resumed invocation span")
	}
	counts := map[string]int{}
	for _, entry := range history {
		if entry["turnId"] == turnID {
			counts[entry["kind"].(string)]++
		}
	}
	for _, kind := range []string{"turnStart", "modelRequest", "response", "modular-agent.stepAfter", "turnEnd"} {
		if counts[kind] != 1 {
			t.Fatalf("expected exactly one %s: %v", kind, counts)
		}
	}
}

func TestServedCustomRuntimeContinuesLateCall(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var starts atomic.Int32
	tool := modular.NewTool("confirm", "Confirm a choice", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
		starts.Add(1)
		return "confirmed", nil
	})
	var answered atomic.Bool
	gate := modular.Plugin{Name: "late-gate", Setup: func(r *modular.Registrar) error {
		return r.OnToolBefore(func(context.Context, modular.ToolBefore) (modular.Gate, error) {
			if answered.Load() {
				return modular.Gate{}, nil
			}
			return modular.Gate{Pending: &modular.Question{Kind: "text", Question: "Proceed?"}}, nil
		}, modular.HookInProcessOnly())
	}}
	a := modulartest.Agent(t, servedTestRuntime(t, "late", ""), modular.WithTool(tool), modular.WithPlugin(gate),
		modular.WithLateAnswersStartTurns(true), modulartest.Script(`[{"toolCalls":[{"name":"confirm","input":{}}]}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.Prompt(ctx, "confirm")
	if err != nil || first.Outcome == nil || first.Outcome.Kind != "completed" || len(first.OpenToolCalls) != 1 || starts.Load() != 0 {
		t.Fatalf("first turn did not leave one call open: %+v, outcome %+v, %v", first, first.Outcome, err)
	}
	qs, err := s.Questions(ctx)
	if err != nil || len(qs) != 1 {
		t.Fatalf("expected an open question: %+v, %v", qs, err)
	}
	answered.Store(true)
	if err := s.Answer(ctx, qs[0].ID, modular.Value("yes")); err != nil {
		t.Fatal(err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	last, err := s.LastTurn(ctx)
	if err != nil || last == nil || last.Outcome == nil || last.Outcome.Kind != "completed" || last.TurnID == first.TurnID ||
		last.Text != "continued: confirmed" || len(last.OpenToolCalls) != 0 || starts.Load() != 1 {
		t.Fatalf("late continuation: %+v, %v; dispatches %d", last, err, starts.Load())
	}
	history, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var linked bool
	results := 0
	for _, entry := range history {
		if entry["kind"] == "turnStart" && entry["turnId"] == last.TurnID {
			var data struct {
				StartedBy modular.StartedBy
			}
			b, _ := json.Marshal(entry["data"])
			linked = json.Unmarshal(b, &data) == nil && entry["continuesTurnId"] == first.TurnID &&
				data.StartedBy.Kind == "answer" && data.StartedBy.ID == qs[0].ID
			if !linked {
				t.Errorf("continuation link %v, starter %+v; want original %s, question %s", entry["continuesTurnId"], data.StartedBy, first.TurnID, qs[0].ID)
			}
		}
		if entry["kind"] == "toolResult" {
			results++
			if entry["toolCallId"] != first.OpenToolCalls[0] || entry["turnId"] != last.TurnID {
				t.Fatalf("continued result did not keep the original call ID: %+v", entry)
			}
		}
	}
	if !linked || results != 1 {
		t.Fatalf("continuation link: %t; results: %d", linked, results)
	}
}
