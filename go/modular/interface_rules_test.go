package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

func interfacePrompt(t *testing.T, ctx context.Context, a *modular.Agent) (*modular.Session, *modular.InterfaceToolConnection, modular.PromptResult) {
	t.Helper()
	s := interfaceSession(t, ctx, a)
	c := interfaceConnect(t, a, s)
	if err := c.Advertise("pick_color"); err != nil {
		t.Fatal(err)
	}
	r, err := s.Prompt(ctx, "Pick a color.")
	if err != nil || r.Outcome == nil || r.Outcome.Kind != "completed" {
		rows, readErr := s.History(context.WithoutCancel(ctx))
		var kinds []any
		for _, row := range rows {
			kinds = append(kinds, row["kind"])
		}
		t.Fatalf("prompt: %+v, %v; history kinds %v, %v", r, err, kinds, readErr)
	}
	return s, c, r
}

func interfaceHistory(t *testing.T, ctx context.Context, s *modular.Session, kind string) []modular.HistoryEntry {
	t.Helper()
	rows, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return slices.DeleteFunc(rows, func(row modular.HistoryEntry) bool { return row["kind"] != kind })
}

func reportFixture(ctx context.Context, c *modular.InterfaceToolConnection, id string) (modular.InterfaceToolReportDisposition, error) {
	return c.ReportToolResult(ctx, modular.InterfaceToolReport{CallID: id, Status: modular.Completed, Content: modular.Text("amber")})
}

func TestInterfaceExpiryAndCancellationSettleUnknown(t *testing.T) {
	for _, mode := range []string{"expiry", "cancel", "close"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			began := make(chan struct{}, 1)
			turns := 0
			plugin := modular.Plugin{Name: "notice-continuation", Setup: func(r *modular.Registrar) error {
				return r.OnTurnStart(func(_ context.Context, _ modular.TurnStart) error {
					turns++
					if turns == 2 {
						began <- struct{}{}
					}
					return nil
				})
			}}
			timeout := int64(30_000)
			if mode == "expiry" {
				timeout = 500
			}
			a := modulartest.Agent(t, append(interfaceOptions(timeout), modular.WithPlugin(plugin), modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()))...)
			s, c, origin := interfacePrompt(t, ctx, a)
			if len(origin.OpenToolCalls) != 1 {
				t.Fatalf("origin: %+v", origin)
			}
			call, err := c.NextHandoff(ctx)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "cancel":
				if _, err := s.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			case "close":
				if err := s.Close(ctx); err != nil {
					t.Fatal(err)
				}
				s, err = a.OpenSession(ctx, s.ID())
				if err != nil {
					t.Fatal(err)
				}
				c = interfaceConnect(t, a, s)
			}
			if mode != "close" {
				select {
				case <-began:
				case <-ctx.Done():
					t.Fatal("system settlement did not continue")
				}
			}
			if err := s.WaitIdle(ctx); err != nil {
				t.Fatal(err)
			}
			if status, err := reportFixture(ctx, c, call.ID); status.Status != modular.InterfaceToolRefused || err != nil {
				t.Fatalf("late report: %v, %v", status, err)
			}
			rows := interfaceHistory(t, ctx, s, "toolResult")
			if len(rows) != 1 || rows[0]["actorId"] != nil || rows[0]["turnId"] != origin.TurnID {
				t.Fatalf("settlement: %v", rows)
			}
			raw, _ := json.Marshal(rows[0]["data"])
			if !strings.Contains(string(raw), `"status":"outcomeUnknown"`) {
				t.Fatalf("settlement: %s", raw)
			}
		})
	}
}

func TestInterfaceNeedsAdvertisementApprovalAndUnchangedOutput(t *testing.T) {
	for _, mode := range []string{"not advertised", "approval declined", "output blocked", "output changed"} {
		t.Run(mode, func(t *testing.T) {
			ctx := t.Context()
			opts := interfaceOptions(30_000)
			switch mode {
			case "approval declined":
				opts = append(opts, modular.WithApproval(modular.All), modular.WithOnQuestion(func(_ context.Context, q modular.Question) (modular.Answer, error) {
					if q.Kind != "approval" {
						return modular.Answer{}, fmt.Errorf("unexpected question kind %s", q.Kind)
					}
					return modular.Decline("No effect."), nil
				}))
			case "output blocked", "output changed":
				opts = append(opts, modular.WithPlugin(modular.Plugin{Name: "gate-handoff", Setup: func(r *modular.Registrar) error {
					return r.OnOutput(func(_ context.Context, batch modular.OutputBatch) (modular.OutputDecision, error) {
						for i, e := range batch.Events {
							if e.Type == "interface.handoff" {
								if batch.Recipient != "editor" {
									return modular.OutputDecision{}, errors.New("wrong handoff recipient")
								}
								if mode == "output blocked" {
									return modular.OutputDecision{Block: true}, nil
								}
								batch.Events[i].Data = json.RawMessage(strings.Replace(string(e.Data), "warm", "cool", 1))
								return modular.OutputDecision{Events: &batch.Events}, nil
							}
						}
						return modular.OutputDecision{}, nil
					})
				}}))
			}
			a := modulartest.Agent(t, opts...)
			s := interfaceSession(t, ctx, a)
			c := interfaceConnect(t, a, s)
			if mode != "not advertised" {
				if err := c.Advertise("pick_color"); err != nil {
					t.Fatal(err)
				}
			}
			direct, err := s.CallTool(ctx, "pick_color", map[string]string{"palette": "warm"})
			if err == nil && direct.Status == modular.Completed {
				t.Fatal("Interface tool dispatched directly")
			}
			prompt, err := s.Prompt(ctx, "Pick a color.")
			if err != nil || len(prompt.OpenToolCalls) != 0 || len(interfaceHistory(t, ctx, s, "toolStarted")) != 0 {
				t.Fatalf("pre-dispatch denial: %+v, %v", prompt, err)
			}
			if mode != "not advertised" {
				results := prompt.ToolResults()
				if len(results) != 1 || results[0].Status != modular.Refused {
					t.Fatalf("should refuse: %+v", results)
				}
			}
		})
	}
}

func TestInterfaceReportChecksRouteScopeAndCeiling(t *testing.T) {
	ctx := t.Context()
	other := modular.InterfaceToolSource{SourceID: "other", ActorID: "editor", RouteID: "editor-secondary", ResultTimeoutMS: 30_000, Tools: []modular.ToolDefinition{{Name: "other_tool", Description: "Unrelated.", Callers: []string{"model"}, Parameters: json.RawMessage(`{}`)}}}
	a := modulartest.Agent(t, append(interfaceOptions(30_000), modular.WithInterfaceTools(other))...)
	s, c, origin := interfacePrompt(t, ctx, a)
	if len(origin.OpenToolCalls) != 1 {
		t.Fatalf("origin: %+v", origin)
	}
	call, err := c.NextHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	wrong, err := a.ConnectInterfaceTools(s.ID(), modular.InterfaceToolConnectionOptions{ActorID: "editor", RouteID: "editor-secondary"})
	if err != nil {
		t.Fatal(err)
	}
	defer wrong.Close()
	if status, err := reportFixture(ctx, wrong, call.ID); status.Status != modular.InterfaceToolRefused || err != nil {
		t.Fatalf("wrong route: %v %v", status, err)
	}
	rights := []string{"watch"}
	narrowed, err := a.ConnectInterfaceTools(s.ID(), modular.InterfaceToolConnectionOptions{ActorID: "editor", RouteID: "editor-primary", Rights: &rights})
	if err != nil {
		t.Fatal(err)
	}
	defer narrowed.Close()
	if status, err := reportFixture(ctx, narrowed, call.ID); status.Status != modular.InterfaceToolRefused || err != nil {
		t.Fatalf("narrow ceiling: %v %v", status, err)
	}
	if _, err := a.ConnectInterfaceTools(s.ID(), modular.InterfaceToolConnectionOptions{ActorID: "editor", RouteID: "editor-primary", Scope: func(string, string) bool { return false }}); err == nil {
		t.Fatal("attached outside scope")
	}
	if status, err := reportFixture(ctx, c, call.ID); status.Status != modular.InterfaceToolAccepted || err != nil {
		t.Fatalf("right route: %v %v", status, err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestInterfaceErasureInvalidatesHandoffAndResult(t *testing.T) {
	for _, erase := range []string{"toolStarted", "toolResult"} {
		t.Run(erase, func(t *testing.T) {
			ctx := t.Context()
			a := modulartest.Agent(t, append(interfaceOptions(30_000), modular.WithDataDir(t.TempDir()), modular.WithDurability(modular.Kept))...)
			s, c, _ := interfacePrompt(t, ctx, a)
			call, err := c.NextHandoff(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if erase == "toolResult" {
				if status, err := reportFixture(ctx, c, call.ID); status.Status != modular.InterfaceToolAccepted || err != nil {
					t.Fatalf("report: %v %v", status, err)
				}
				if err := s.WaitIdle(ctx); err != nil {
					t.Fatal(err)
				}
			}
			records := interfaceHistory(t, ctx, s, erase)
			if len(records) != 1 {
				t.Fatalf("before erase: %v", records)
			}
			erasure, err := s.Erase(ctx, []string{records[0]["id"].(string)})
			if err != nil || len(erasure.Erased) == 0 || !slices.ContainsFunc(erasure.OutOfReach, func(x string) bool { return strings.Contains(x, "Interface executor") }) {
				t.Fatalf("erase: %+v %v", erasure, err)
			}
			if status, err := reportFixture(ctx, c, call.ID); status.Status != modular.InterfaceToolRefused || err != nil {
				t.Fatalf("report after erasure: %v %v", status, err)
			}
			kept := interfaceHistory(t, ctx, s, erase)
			if len(kept) != 1 || kept[0]["erased"] != true || kept[0]["data"] != nil || kept[0]["message"] != nil {
				t.Fatalf("erased payload still visible: %v", kept)
			}
		})
	}
}

func TestInterfaceReportBeforeTurnEndCanBeRetried(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	release := make(chan struct{})
	plugin := modular.Plugin{Name: "hold-open-step", Setup: func(r *modular.Registrar) error {
		return r.OnStepAfter(func(ctx context.Context, step modular.StepAfter) (modular.StepDecision, error) {
			if len(step.Response.Content) > 0 && step.Response.Content[0].Type == "toolCall" {
				select {
				case <-release:
				case <-ctx.Done():
					return modular.StepDecision{}, ctx.Err()
				}
			}
			return modular.StepDecision{}, nil
		})
	}}
	a := modulartest.Agent(t, append(interfaceOptions(30_000), modular.WithPlugin(plugin))...)
	s := interfaceSession(t, ctx, a)
	c := interfaceConnect(t, a, s)
	if err := c.Advertise("pick_color"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Send(ctx, "Pick a color.", modular.Now); err != nil {
		t.Fatal(err)
	}
	call, err := c.NextHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status, err := reportFixture(ctx, c, call.ID); status.Status != modular.InterfaceToolRefused || status.Reason != modular.InterfaceToolNotReady || err != nil {
		t.Fatalf("early report: %v %v", status, err)
	}
	close(release)
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if status, err := reportFixture(ctx, c, call.ID); status.Status != modular.InterfaceToolAccepted || err != nil {
		t.Fatalf("report after turn end: %v %v", status, err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestInterfaceTelemetryLinksWithoutPayload(t *testing.T) {
	mem := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(mem))
	otel.SetTracerProvider(tp)
	t.Cleanup(func() { otel.SetTracerProvider(tracenoop.NewTracerProvider()); _ = tp.Shutdown(context.Background()) })
	ctx := t.Context()
	a := modulartest.Agent(t, interfaceOptions(30_000)...)
	s, c, _ := interfacePrompt(t, ctx, a)
	call, err := c.NextHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status, err := reportFixture(ctx, c, call.ID); status.Status != modular.InterfaceToolAccepted || err != nil {
		t.Fatalf("report: %v %v", status, err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	var handoff, report, settle tracetest.SpanStub
	var turns []tracetest.SpanStub
	for _, sp := range mem.GetSpans() {
		if text := fmt.Sprint(sp.Name, sp.Attributes, sp.Events, sp.Links, sp.Status); strings.Contains(text, "amber") || strings.Contains(text, "warm") || strings.Contains(text, "editor-primary") {
			t.Fatalf("payload in trace: %s", text)
		}
		switch sp.Name {
		case "execute_tool pick_color":
			handoff = sp
		case "modular_agent.tool.report":
			report = sp
		case "modular_agent.tool.settle":
			settle = sp
		case "invoke_agent":
			turns = append(turns, sp)
		}
	}
	if !handoff.SpanContext.IsValid() || !strings.Contains(fmt.Sprint(handoff.Attributes), "pending") || !settle.SpanContext.IsValid() || !settle.Parent.Equal(report.SpanContext) || len(settle.Links) != 1 || !settle.Links[0].SpanContext.Equal(handoff.SpanContext) {
		t.Fatalf("handoff=%+v report=%+v settle=%+v", handoff, report, settle)
	}
	if len(turns) != 2 || len(turns[1].Links) != 1 || turns[1].Links[0].SpanContext.TraceID() != turns[0].SpanContext.TraceID() || turns[1].Links[0].SpanContext.SpanID() != turns[0].SpanContext.SpanID() {
		t.Fatalf("continuation span: %+v", turns)
	}
}

func TestInterfaceOptionDoesNotChangeDefaultAgent(t *testing.T) {
	ctx := t.Context()
	tool := modular.NewTool("pick_color", "Pick a color.", func(context.Context, struct {
		Palette string `json:"palette"`
	}, *modular.ToolContext) (string, error) {
		return "local", nil
	})
	a := modulartest.Agent(t, modulartest.Script(interfaceScript), modular.WithTool(tool))
	if _, ok := a.Declaration()["interfaceTools"]; ok {
		t.Fatal("agent without option declared support")
	}
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.Prompt(ctx, "Pick a color.")
	if results := r.ToolResults(); err != nil || r.Text != "done" || len(results) != 1 || results[0].Text() != "local" || len(r.OpenToolCalls) != 0 {
		t.Fatalf("ordinary tool: %+v %v", r, err)
	}
}
