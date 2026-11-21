package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestDynamicSourceAndJobs(t *testing.T) {
	for _, wire := range []bool{false, true} {
		name := "local"
		if wire {
			name = "wire"
		}
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			var change modular.ToolChanges
			var extra atomic.Bool
			ids := make(chan string, 1)
			work := modular.NewTool("begin", "Begin work.", func(ctx context.Context, _ struct{}, c *modular.ToolContext) (string, error) {
				j, err := c.Jobs.Start(ctx, "example", map[string]string{"status": "started"})
				if err != nil {
					return "", err
				}
				ids <- j.ID
				extra.Store(true)
				return "ready", change.Changed(ctx)
			})
			second := modular.NewTool("extra", "A new tool.", func(context.Context, struct{}, *modular.ToolContext) (string, error) { return "new", nil })
			p := modular.Plugin{Name: "dynamic-jobs", Setup: func(r *modular.Registrar) error {
				return errors.Join(r.Jobs(modular.JobOwner{Cancel: func(ctx context.Context, j *modular.Job) error {
					return j.End(ctx, modular.Outcome{Kind: "cancelled"}, nil, false)
				}}), r.Tools(modular.ToolSource{ID: "dynamic", Changes: &change, Tools: func(string) []modular.Tool {
					if extra.Load() {
						return []modular.Tool{work, second}
					}
					return []modular.Tool{work}
				}}))
			}}
			opt := modular.WithPlugin(p)
			if wire {
				opt = modulartest.OverWire(p)
			}
			a := modulartest.Agent(t, opt)
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			got, err := s.CallTool(ctx, "begin", struct{}{})
			if err != nil || got.Text() != "ready" {
				t.Fatalf("begin: %v %v", got, err)
			}
			got, err = s.CallTool(ctx, "extra", struct{}{})
			if err != nil || got.Text() != "new" {
				t.Fatalf("extra: %v %v", got, err)
			}
			if err = s.CancelJob(ctx, <-ids); err != nil {
				t.Fatal(err)
			}
			history, err := s.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var ended bool
			for _, e := range history {
				ended = ended || e["kind"] == "jobEnded"
			}
			if !ended {
				t.Fatal("no committed job end")
			}
		})
	}
}

func TestEmbeddedProposalsMoveAndErase(t *testing.T) {
	ctx := t.Context()
	a := modulartest.Agent(t, modular.WithSeveralActors(true), modulartest.Script(`[{"text":"first"},{"text":"second"}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	one, err := s.Send(ctx, modular.Text("discard"), modular.Propose)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Withdraw(ctx, one.InputID); err != nil {
		t.Fatal(err)
	}
	requireCode(t, s.Withdraw(ctx, one.InputID), modular.Conflict)
	_, err = s.Release(ctx, one.InputID, modular.Now)
	requireCode(t, err, modular.Conflict)
	decline, err := s.Send(ctx, "decline", modular.Propose)
	if err != nil {
		t.Fatal(err)
	}
	if receipt, err := s.Release(ctx, decline.InputID, modular.Now, true); err != nil || receipt.InputID != decline.InputID || receipt.Disposition != "handedBack" {
		t.Fatalf("decline: %+v %v", receipt, err)
	}
	requireCode(t, s.Withdraw(ctx, decline.InputID), modular.Conflict)
	two, err := s.Send(ctx, "deliver", modular.Propose)
	if err != nil {
		t.Fatal(err)
	}
	parked, err := s.Proposals(ctx)
	if err != nil || len(parked) != 1 {
		t.Fatalf("proposals: %+v %v", parked, err)
	}
	if _, err = s.Release(ctx, two.InputID, modular.Now); err != nil {
		t.Fatal(err)
	}
	_, err = s.Release(ctx, two.InputID, modular.Now)
	requireCode(t, err, modular.Conflict)
	if parked, err = s.Proposals(ctx); err != nil || len(parked) != 0 {
		t.Fatalf("settled proposals still listed: %+v %v", parked, err)
	}
	if err = s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	past, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var tip string
	for _, e := range past {
		if e["kind"] == "turnEnd" {
			tip = e["id"].(string)
		}
	}
	if tip == "" {
		t.Fatalf("no settled turn to move to: %v", past)
	}
	if turn, err := s.Prompt(ctx, "again"); err != nil || turn.Text != "second" {
		t.Fatalf("prompt: %+v %v", turn, err)
	}
	all, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var target string
	for _, entry := range all[len(past):] {
		if entry["kind"] == "response" {
			target = entry["id"].(string)
		}
	}
	if target == "" {
		t.Fatal("no response entry")
	}
	if err = s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.MoveTo(ctx, tip); err != nil {
		t.Fatal(err)
	}
	// The next prompt should see the first turn, not the abandoned second turn.
	turn, err := s.Prompt(ctx, "after move")
	if err != nil || turn.Text != "second" {
		t.Fatalf("after move: %+v %v", turn, err)
	}
	if err = s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	report, err := s.Erase(ctx, []string{target})
	if err != nil || len(report.Erased) == 0 {
		t.Fatalf("erase: %+v %v", report, err)
	}
}

func TestPublicCustomHooksQuestionAndContext(t *testing.T) {
	ctx := t.Context()
	var observed []string
	var saved *modular.HookContext
	p := modular.Plugin{Name: "extensions", Setup: func(r *modular.Registrar) error {
		return errors.Join(r.DefineHook("demo.collect", modular.Collect), r.On("demo.collect", func(ctx context.Context, p modular.HookPayload) (modular.HookAnswer, error) {
			saved = modular.HookContextFrom(ctx)
			history, err := saved.History(ctx)
			if err != nil || saved.SessionID == "" || len(history.Entries) == 0 {
				return nil, errors.New("no scoped history page")
			}
			return modular.HookAnswer{"value": p["text"]}, nil
		}), r.OnSessionJoin(func(_ context.Context, p modular.ActorChange) error {
			observed = append(observed, "join:"+p.Actor.ID)
			return nil
		}), r.OnSessionLeave(func(_ context.Context, p modular.ActorChange) error {
			observed = append(observed, "leave:"+p.Actor.ID)
			return nil
		}), r.Command(modular.Command{Name: "ask", Description: "Ask and collect.", InProcessOnly: true, Run: func(ctx context.Context, _ string, c *modular.CommandContext) (string, error) {
			q, err := c.Ask(ctx, modular.Question{Kind: "text", Question: "Which harbour?"})
			if err != nil {
				return "", err
			}
			value, err := c.CallHook(ctx, "demo.collect", map[string]any{"text": q.Value})
			if err != nil {
				return "", err
			}
			raw, err := json.Marshal(value)
			return string(raw), err
		}}))
	}}
	a := modulartest.Agent(t, modular.WithPlugin(p), modular.WithSeveralActors(true), modular.WithOnQuestion(func(context.Context, modular.Question) (modular.Answer, error) { return modular.Value("Whitby"), nil }))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Join(ctx, modular.Actor{ID: "reader", Kind: "user", Rights: []string{"watch"}}); err != nil {
		t.Fatal(err)
	}
	if err = s.Leave(ctx, "reader"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(observed, ",") != "join:reader,leave:reader" {
		t.Fatalf("observed %v", observed)
	}
	want := `["Whitby"]`
	if out, err := s.RunCommand(ctx, "/ask"); err != nil || out != want {
		t.Fatalf("command: %q %v", out, err)
	}
	if _, err = saved.History(ctx); err == nil {
		t.Fatal("stale hook context could read history")
	} else {
		assertCode(t, err, modular.InvalidRequest)
	}
}
