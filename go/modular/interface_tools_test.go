package modular_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

const interfaceScript = `[{"toolCalls":[{"name":"pick_color","input":{"palette":"warm"}}]},{"text":"done"}]`

func interfaceOptions(ms int64) []modular.Option {
	return []modular.Option{modular.WithSeveralActors(true), modular.WithInterfaceTools(modular.InterfaceToolSource{
		SourceID: "palette", ActorID: "editor", RouteID: "editor-primary", ResultTimeoutMS: ms,
		Tools: []modular.ToolDefinition{{Name: "pick_color", Description: "Pick a color.", Parameters: json.RawMessage(`{"type":"object"}`), Callers: []string{"model"}}},
	}), modulartest.Script(interfaceScript)}
}

func interfaceSession(t *testing.T, ctx context.Context, a *modular.Agent) *modular.Session {
	t.Helper()
	s, err := a.Session(ctx, modular.SessionOptions{Actors: []modular.Actor{{ID: "editor", Kind: "program", Rights: []string{"watch", "tools"}}}})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func interfaceConnect(t *testing.T, a *modular.Agent, s *modular.Session) *modular.InterfaceToolConnection {
	t.Helper()
	c, err := a.ConnectInterfaceTools(s.ID(), modular.InterfaceToolConnectionOptions{ActorID: "editor", RouteID: "editor-primary"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestInterfaceResultFromNewConnectionContinuesWithoutInput(t *testing.T) {
	for _, placement := range []string{"in-process", "served Runtime"} {
		t.Run(placement, func(t *testing.T) {
			opts := interfaceOptions(30_000)
			if placement == "served Runtime" {
				opts = append(opts, interfaceServedRuntime(t, false))
			}
			checkInterfaceResultFromNewConnection(t, opts)
		})
	}
}

func checkInterfaceResultFromNewConnection(t *testing.T, opts []modular.Option) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	a := modulartest.Agent(t, opts...)
	s := interfaceSession(t, ctx, a)
	first := interfaceConnect(t, a, s)
	if err := first.Advertise("pick_color"); err != nil {
		t.Fatal(err)
	}
	origin, err := s.Prompt(ctx, "Pick a color.")
	if err != nil || origin.Outcome == nil || origin.Outcome.Kind != "completed" || len(origin.OpenToolCalls) != 1 {
		t.Fatalf("expected open call: %+v, %v", origin, err)
	}
	call, err := first.NextHandoff(ctx)
	if err != nil || call.Name != "pick_color" || call.ID != origin.OpenToolCalls[0] {
		t.Fatalf("handoff: %+v %v", call, err)
	}
	first.Close()
	second := interfaceConnect(t, a, s)
	status, err := second.ReportToolResult(ctx, modular.InterfaceToolReport{CallID: call.ID, Status: modular.Completed, Content: modular.Text("amber")})
	if err != nil || status != modular.InterfaceToolAccepted {
		t.Fatalf("report: %v, %v", status, err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	last, err := s.LastTurn(ctx)
	if err != nil || last == nil || last.Text != "done" || last.TurnID == origin.TurnID {
		t.Fatalf("continuation: %+v %v", last, err)
	}
	rows, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var starts, inputs, results int
	for _, row := range rows {
		switch row["kind"] {
		case "toolStarted":
			starts++
		case "inputAccepted":
			inputs++
		case "toolResult":
			results++
			if row["actorId"] != "editor" || row["turnId"] != origin.TurnID {
				t.Fatalf("wrong result attribution: %v", row)
			}
		case "modular-agent.interfaceHandoff":
			if row["data"] != nil {
				t.Fatalf("checkpoint data is private: %v", row)
			}
		}
	}
	if starts != 1 || inputs != 1 || results != 1 {
		t.Fatalf("got %d starts, %d inputs, %d results", starts, inputs, results)
	}
}

func interfaceServedRuntime(t *testing.T, durable bool) modular.Option {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	kind := "kept"
	if durable {
		kind = "durable"
	}
	return modular.WithProcessPlugin(modular.ProcessPlugin{Command: []string{exe, "-test.run=^TestInterfaceRuntimeProgram$"}, Env: map[string]string{"MA_TEST_INTERFACE_RUNTIME": kind}})
}

func TestInterfaceRuntimeProgram(t *testing.T) {
	mode := os.Getenv("MA_TEST_INTERFACE_RUNTIME")
	if mode == "" {
		t.Skip("only run in the Runtime child")
	}
	runtime := modular.TransientRuntime()
	if mode == "durable" {
		runtime = modular.DurableRuntime()
	}
	plugin := modular.Plugin{Name: "interface-fixture-runtime", Replaces: []string{"runtime"}, Setup: func(r *modular.Registrar) error { return r.Runtime(runtime) }}
	if err := modular.Serve(t.Context(), plugin); err != nil {
		t.Fatal(err)
	}
	os.Exit(0)
}

func TestInterfaceTwoReportsRace(t *testing.T) {
	ctx := t.Context()
	var calls int
	checked := modular.Plugin{Name: "check-report", Setup: func(r *modular.Registrar) error {
		return r.OnToolAfter(func(_ context.Context, after modular.ToolAfter) (modular.ToolChange, error) {
			calls++
			content := modular.Text("checked " + after.Result.Text())
			return modular.ToolChange{Content: &content}, nil
		})
	}}
	a := modulartest.Agent(t, append(interfaceOptions(30_000), modular.WithPlugin(checked))...)
	s := interfaceSession(t, ctx, a)
	conn := interfaceConnect(t, a, s)
	if err := conn.Advertise("pick_color"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prompt(ctx, "Pick a color."); err != nil {
		t.Fatal(err)
	}
	call, err := conn.NextHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	report := func(c *modular.InterfaceToolConnection, col string) (modular.InterfaceToolReportDisposition, error) {
		return c.ReportToolResult(ctx, modular.InterfaceToolReport{CallID: call.ID, Status: modular.Completed, Content: modular.Text(col)})
	}
	second := interfaceConnect(t, a, s)
	start := make(chan struct{})
	var wg sync.WaitGroup
	statuses := make([]modular.InterfaceToolReportDisposition, 2)
	errs := make([]error, 2)
	for i, c := range []*modular.InterfaceToolConnection{conn, second} {
		wg.Go(func() { <-start; statuses[i], errs[i] = report(c, []string{"red", "gold"}[i]) })
	}
	close(start)
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || statuses[0] == statuses[1] || statuses[0] == modular.InterfaceToolRefused || statuses[1] == modular.InterfaceToolRefused {
		t.Fatalf("reports: %v, tool.after ran %d times", statuses, calls)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	history, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, row := range history {
		if row["kind"] == "toolResult" {
			n++
			raw, _ := json.Marshal(row["message"])
			want := "checked red"
			if statuses[1] == modular.InterfaceToolAccepted {
				want = "checked gold"
			}
			if !strings.Contains(string(raw), want) {
				t.Fatalf("result lacks checked content: %s", raw)
			}
		}
	}
	if n != 1 {
		t.Fatalf("terminal record count %d", n)
	}
}

func TestInterfaceCrashProcess(t *testing.T) {
	dir := os.Getenv("MA_TEST_INTERFACE_CRASH_DIR")
	if dir == "" {
		t.Skip("only run in the agent child")
	}
	mode := os.Getenv("MA_TEST_INTERFACE_CRASH_MODE")
	ctx := t.Context()
	opts := append(interfaceOptions(120_000), modular.WithProject(filepath.Join(dir, "project")), modular.WithDataDir(filepath.Join(dir, "data")), modular.WithEnvironment(modulartest.MemoryEnvironment()))
	if mode != "kept" {
		opts = append(opts, modular.WithDurability(modular.Durable))
	} else {
		opts = append(opts, modular.WithDurability(modular.Kept))
	}
	if mode == "served-durable" {
		opts = append(opts, interfaceServedRuntime(t, true))
	}
	if mode != "kept" {
		opts = append(opts, modular.WithPlugin(interfaceHoldStep()))
	}
	a, err := modular.New(ctx, opts...)
	if err != nil {
		t.Fatal(err)
	}
	s := interfaceSession(t, ctx, a)
	c := interfaceConnect(t, a, s)
	if err := c.Advertise("pick_color"); err != nil {
		t.Fatal(err)
	}
	if mode == "kept" {
		if _, err := s.Prompt(ctx, "Pick a color."); err != nil {
			t.Fatal(err)
		}
	} else if _, err := s.Send(ctx, "Pick a color.", modular.Now); err != nil {
		t.Fatal(err)
	}
	call, err := c.NextHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("HANDOFF %s %s\n", s.ID(), call.ID)
	<-ctx.Done()
}

func interfaceHoldStep() modular.Plugin {
	return modular.Plugin{Name: "hold-interface-step", Setup: func(r *modular.Registrar) error {
		return r.OnStepAfter(func(ctx context.Context, s modular.StepAfter) (modular.StepDecision, error) {
			if os.Getenv("MA_TEST_INTERFACE_CRASH_DIR") != "" {
				<-ctx.Done()
				return modular.StepDecision{}, ctx.Err()
			}
			return modular.StepDecision{}, nil
		})
	}}
}

func TestInterfaceCheckpointSurvivesSIGKILL(t *testing.T) {
	for _, mode := range []string{"kept", "durable", "served-durable"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			dir := t.TempDir()
			project := filepath.Join(dir, "project")
			if err := os.Mkdir(project, 0700); err != nil {
				t.Fatal(err)
			}
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.CommandContext(ctx, exe, "-test.run=^TestInterfaceCrashProcess$")
			cmd.Env = append(os.Environ(), "MA_TEST_INTERFACE_CRASH_DIR="+dir, "MA_TEST_INTERFACE_CRASH_MODE="+mode)
			output, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = cmd.Stdout
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
			reader := bufio.NewScanner(output)
			var session, call string
			var failure []string
			for reader.Scan() {
				line := reader.Text()
				if strings.HasPrefix(line, "HANDOFF ") {
					fields := strings.Fields(line)
					session, call = fields[1], fields[2]
					break
				}
				failure = append(failure, line)
			}
			if session == "" {
				t.Fatalf("agent never handed off: %s; %v", strings.Join(failure, "\n"), reader.Err())
			}
			if err := cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := cmd.Wait(); err == nil {
				t.Fatal("child exited without SIGKILL")
			}
			opts := append(interfaceOptions(120_000), modular.WithProject(project), modular.WithDataDir(filepath.Join(dir, "data")))
			if mode == "kept" {
				opts = append(opts, modular.WithDurability(modular.Kept))
			} else {
				opts = append(opts, modular.WithDurability(modular.Durable), modular.WithPlugin(interfaceHoldStep()))
			}
			if mode == "served-durable" {
				opts = append(opts, interfaceServedRuntime(t, true))
			}
			a := modulartest.Agent(t, opts...)
			s, err := a.OpenSession(ctx, session)
			if err != nil {
				t.Fatal(err)
			}
			c := interfaceConnect(t, a, s)
			status, err := c.ReportToolResult(ctx, modular.InterfaceToolReport{CallID: call, Status: modular.Completed, Content: modular.Text("amber")})
			if err != nil || status != modular.InterfaceToolAccepted {
				t.Fatalf("report after SIGKILL: %s %v", status, err)
			}
			if err := s.WaitIdle(ctx); err != nil {
				t.Fatal(err)
			}
			result, err := s.LastTurn(ctx)
			if err != nil || result == nil || result.Text != "done" {
				t.Fatalf("continuation: %+v %v", result, err)
			}
		})
	}
}
