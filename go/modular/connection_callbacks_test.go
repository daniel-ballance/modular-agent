package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestServedEnvironmentOutputCanReadFromSameEnvironment(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	env := modular.Plugin{Name: "streaming-env", Replaces: []string{"working-environment"}, Setup: func(r *modular.Registrar) error {
		return r.Environment(modular.NewEnvironment(streamingEnvironment{}))
	}}
	local := modular.Plugin{Name: "read-on-progress", Setup: func(r *modular.Registrar) error {
		return r.Tool(modular.NewTool("inspect", "Read the environment during output", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
			var seen string
			var readErr error
			_, err := tc.Environment.Exec(ctx, "inspect", 0, func(chunk string) {
				b, err := tc.Environment.Read(ctx, "result")
				readErr = err
				seen += chunk + string(b)
			})
			return seen, errors.Join(err, readErr)
		}))
	}}
	a := newCallbackTestAgent(t, ctx, modulartest.OverWire(env), modular.WithPlugin(local))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	call := make(chan error, 1)
	go func() {
		result, err := s.CallTool(ctx, "inspect", struct{}{})
		if err == nil && result.Text() != "reading: contents" {
			err = fmt.Errorf("unexpected tool result: %s", result.Text())
		}
		call <- err
	}()
	if err := takeInterruptionCheck(t, ctx, call, "environment read from a progress callback"); err != nil {
		t.Fatal(err)
	}
}

type streamingEnvironment struct{ demoEnvironment }

func (streamingEnvironment) Read(context.Context, modular.EnvironmentPath) ([]byte, error) {
	return []byte("contents"), nil
}
func (streamingEnvironment) Exec(_ context.Context, _ modular.EnvironmentExec, emit func(string)) (modular.ExecResult, error) {
	emit("reading: ")
	code := 0
	return modular.ExecResult{Output: "reading: ", ExitCode: &code}, nil
}
func (streamingEnvironment) SessionEnded(context.Context, string) error { return nil }

func TestServedCatalogRefreshAndEmitThroughOwnGate(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	const event = "plugin.catalog.catalog.changed"
	var changes modular.ToolChanges
	var changed atomic.Bool
	update := modular.NewTool("update", "Add another tool", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		changed.Store(true)
		// No parent: tools/list is itself a callback on the serving connection.
		return "updated", errors.Join(changes.Changed(), tc.Emit(ctx, "catalog.changed", "ready"))
	})
	added := modular.NewTool("added", "Newly listed tool", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
		return "available", nil
	})
	plugin := modular.Plugin{Name: "catalog", Setup: func(r *modular.Registrar) error {
		return errors.Join(r.OnOutput(markGatedEvent(event)), r.Tools(modular.ToolSource{
			ID: "catalog", Changes: &changes, Tools: func(string) []modular.Tool {
				if changed.Load() {
					return []modular.Tool{update, added}
				}
				return []modular.Tool{update}
			},
		}))
	}}
	a := newCallbackTestAgent(t, ctx, modulartest.OverWire(plugin))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	events := followCallbackEvent(t, ctx, s, event)
	call := make(chan error, 1)
	go func() {
		result, err := s.CallTool(ctx, "update", struct{}{})
		if err == nil && result.Text() != "updated" {
			err = fmt.Errorf("update: %s", result.Text())
		}
		call <- err
	}()
	if got := takeInterruptionCheck(t, ctx, events, event); got != `"gated: ready"` {
		t.Fatalf("event: %s", got)
	}
	if err := takeInterruptionCheck(t, ctx, call, "catalog update"); err != nil {
		t.Fatal(err)
	}
	if got, err := s.CallTool(ctx, "added", struct{}{}); err != nil || got.Text() != "available" {
		t.Fatalf("refreshed catalog: %s, %v", got.Text(), err)
	}
}

func TestServedRuntimeModelPiecesAndReportOnSameConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	p := modular.Plugin{Name: "model-pieces", Setup: func(r *modular.Registrar) error {
		return errors.Join(r.Runtime(modular.NewRuntime(reportingRuntime{})),
			r.Provider(modulartest.ScriptedProvider([]modulartest.Reply{{Text: "answer"}})),
			r.OnOutput(markGatedEvent(runtimeReportEvent)))
	}}
	a := newCallbackTestAgent(t, ctx, modulartest.OverWire(p), modular.WithModel("scripted/script"))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	events := followCallbackEvent(t, ctx, s, runtimeReportEvent)
	turn := make(chan error, 1)
	go func() {
		result, err := s.Prompt(ctx, "generate")
		if err == nil && result.Text != "answer" {
			err = fmt.Errorf("turn: %+v", result)
		}
		turn <- err
	}()
	if got := takeInterruptionCheck(t, ctx, events, runtimeReportEvent); got != `"gated: answer"` {
		t.Fatalf("Runtime report: %s", got)
	}
	if err := takeInterruptionCheck(t, ctx, turn, "Runtime turn"); err != nil {
		t.Fatal(err)
	}
}

const runtimeReportEvent = "plugin.model-pieces.model.verified"

type reportingRuntime struct{ demoRuntime }

func (reportingRuntime) RunTurn(ctx context.Context, _ modular.RuntimeInput, c *modular.RuntimeContext) (out modular.TurnOutcome, err error) {
	step, err := c.NewID(ctx)
	if err != nil {
		return out, err
	}
	req, err := c.PrepareStep(ctx, step, modular.Usage{})
	if err != nil {
		return out, err
	}
	var streamed string
	var historyErr error
	msg, err := c.Model(ctx, step, req, func(piece modular.ModelStreamEvent) {
		// A piece handler must be able to get a reply from the same peer.
		if _, err := c.History(ctx); err != nil {
			historyErr = err
		}
		streamed += piece.Delta
	})
	if err := errors.Join(err, historyErr); err != nil {
		return out, err
	}
	if streamed != "answer" {
		return out, fmt.Errorf("model stream: %q", streamed)
	}
	row, err := c.Record(ctx, modular.HistoryEntry{"kind": "response", "stepId": step, "message": msg})
	if err != nil {
		return out, err
	}
	if _, err := c.Hook(ctx, "step.after", modular.HookPayload{"stepId": step, "response": msg}); err != nil {
		return out, err
	}
	if err := c.Report(ctx, runtimeReportEvent, streamed, step, ""); err != nil {
		return out, err
	}
	return modular.TurnOutcome{Outcome: modular.Outcome{Kind: "completed"}, Result: modular.TurnResult{Text: msg.Content.Text()},
		Entries: []string{row["id"].(string)}, Usage: msg.Usage}, nil
}

func followCallbackEvent(t *testing.T, ctx context.Context, s *modular.Session, kind string) <-chan string {
	t.Helper()
	ready, found := make(chan struct{}), make(chan string, 1)
	go func() {
		defer close(found)
		first := true
		for event, err := range s.Events(ctx) {
			if first {
				close(ready)
				first = false
			}
			if err != nil {
				return
			}
			if event, ok := event.(modular.DataEvent); ok && event.Type == kind {
				found <- string(event.Data)
				return
			}
		}
	}()
	takeInterruptionCheck(t, ctx, ready, "events follower")
	return found
}

func markGatedEvent(kind string) func(context.Context, modular.OutputBatch) (modular.OutputDecision, error) {
	return func(_ context.Context, batch modular.OutputBatch) (modular.OutputDecision, error) {
		for i, event := range batch.Events {
			if event.Type == kind {
				var value string
				if err := json.Unmarshal(event.Data, &value); err != nil {
					return modular.OutputDecision{}, err
				}
				batch.Events[i].Data, _ = json.Marshal("gated: " + value)
			}
		}
		return modular.OutputDecision{Events: &batch.Events}, nil
	}
}

func newCallbackTestAgent(t *testing.T, ctx context.Context, options ...modular.Option) *modular.Agent {
	t.Helper()
	options = append([]modular.Option{modular.WithProject(t.TempDir()), modular.WithEnvironment(modulartest.MemoryEnvironment())}, options...)
	a, err := modular.New(ctx, options...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Bound cleanup as well as assertions if connection shutdown wedges.
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- a.Close(closeCtx) }()
		if err := takeInterruptionCheck(t, closeCtx, done, "agent shutdown"); err != nil {
			t.Error(err)
		}
	})
	return a
}
