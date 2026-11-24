package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestPromptQueuesAndCancelHandsBack(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	started := make(chan struct{})
	hold := modular.NewTool("hold", "Wait for cancel.", func(ctx context.Context, _ struct{}, _ *modular.ToolContext) (string, error) {
		close(started)
		<-ctx.Done()
		return "", ctx.Err()
	})
	a := modulartest.Agent(t, modular.WithTool(hold), modulartest.Script(`[{"toolCalls":[{"name":"hold","input":{}}]}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	type reply struct {
		r   modular.PromptResult
		err error
	}
	result := make(chan reply, 2)
	go func() { r, e := s.Prompt(ctx, "hold"); result <- reply{r, e} }()
	select {
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	case <-started:
	}
	go func() { r, e := s.Prompt(ctx, "queued", modular.WithInputKey("queued")); result <- reply{r, e} }()
	var key string
	for key == "" {
		entries, err := s.History(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			if e["kind"] == "inputAccepted" {
				b, _ := json.Marshal(e)
				if strings.Contains(string(b), `"queued"`) {
					key = "queued"
				}
			}
		}
		if key == "" {
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(time.Millisecond):
			}
		}
	}
	returned, err := s.Cancel(ctx)
	if err != nil || len(returned) != 1 {
		t.Fatalf("cancel: %#v %v", returned, err)
	}
	var got []modular.Disposition
	for range 2 {
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case p := <-result:
			if p.err != nil {
				t.Fatal(p.err)
			}
			got = append(got, p.r.Disposition)
			if p.r.Disposition == modular.Turn && (p.r.Outcome.Kind != "cancelled" || p.r.ToolResults()[0].Status != modular.Cancelled) {
				t.Fatalf("cancelled turn %#v", p.r)
			}
			if p.r.Disposition == modular.HandedBack && p.r.InputID != returned[0].InputID {
				t.Fatal("wrong input handed back")
			}
		}
	}
	slices.Sort(got)
	if !reflect.DeepEqual(got, []modular.Disposition{modular.HandedBack, modular.Turn}) {
		t.Fatal(got)
	}
}

func TestToolHintAndSchemaParity(t *testing.T) {
	d := Tide.Definition()
	if !d.Hints.ReadOnly || !d.Hints.Destructive || !d.Hints.OpenWorld || d.Hints.SafeToRepeat || !strings.Contains(string(d.Parameters), "2020-12") || !strings.Contains(string(d.Parameters), "The harbour to look up.") {
		t.Fatalf("definition: %#v", d)
	}
	for _, tc := range []struct {
		name, input string
		status      modular.ToolStatus
	}{
		{"readOnly approval exemption", `{"harbour":"Whitby"}`, modular.Completed},
		{"required field", `{}`, modular.Failed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := modulartest.Agent(t, modular.WithTool(Tide), modular.WithApproval(modular.Ask), modulartest.Script(`[{"toolCalls":[{"name":"tide","input":`+tc.input+`}]},{"text":"done"}]`))
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.Prompt(t.Context(), "tide")
			if err != nil {
				t.Fatal(err)
			}
			if len(r.ToolResults()) != 1 || r.ToolResults()[0].Status != tc.status {
				t.Fatal(r.ToolResults())
			}
		})
	}
}

func TestSessionSettingsForkAndReopen(t *testing.T) {
	ctx := t.Context()
	a := modulartest.Agent(t, modulartest.Script(`[{"text":"first"},{"text":"second"}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetSetting(ctx, "maxSteps", 3); err != nil {
		t.Fatal(err)
	}
	settings, err := s.Settings(ctx)
	if err != nil || settings["maxSteps"] != 3 {
		t.Fatalf("settings: %v %v", settings, err)
	}
	r, err := s.Prompt(ctx, "first")
	if err != nil {
		t.Fatal(err)
	}
	originalID := s.ID()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	s, err = a.OpenSession(ctx, originalID)
	if err != nil {
		t.Fatal(err)
	}
	last, err := s.LastTurn(ctx)
	if err != nil || last == nil || last.TurnID != r.TurnID {
		t.Fatalf("last: %#v %v", last, err)
	}
	fork, err := s.Fork(ctx)
	if err != nil || fork.ID() == s.ID() {
		t.Fatalf("fork: %#v %v", fork, err)
	}
	next, err := fork.Prompt(ctx, "next")
	if err != nil || next.Text != "second" {
		t.Fatalf("fork result: %#v %v", next, err)
	}
}

func TestItemReplacement(t *testing.T) {
	one := modular.NewTool("one", "One.", func(context.Context, struct{}, *modular.ToolContext) (string, error) { return "old", nil })
	another := modular.NewTool("another", "Another.", func(context.Context, struct{}, *modular.ToolContext) (string, error) { return "keep", nil })
	changed := modular.NewTool("one", "New one.", func(context.Context, struct{}, *modular.ToolContext) (string, error) { return "new", nil })
	p := modular.Plugin{Name: "pair", Setup: func(r *modular.Registrar) error {
		if err := r.Tool(one); err != nil {
			return err
		}
		return r.Tool(another)
	}}
	replacement := modular.Plugin{Name: "change", Replaces: []string{"tool:one"}, Setup: func(r *modular.Registrar) error { return r.Tool(changed) }}
	a := modulartest.Agent(t, modular.WithPlugin(p), modular.WithPlugin(replacement), modulartest.Script(`[{"toolCalls":[{"name":"one","input":{}},{"name":"another","input":{}}]},{"text":"done"}]`))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.Prompt(t.Context(), "both")
	if err != nil {
		t.Fatal(err)
	}
	results := r.ToolResults()
	if len(results) != 2 || results[0].Text() != "new" || results[1].Text() != "keep" {
		t.Fatal(results)
	}
	replacement.Replaces = []string{"tool:another"}
	_, err = modular.New(t.Context(), modular.WithPlugin(p), modular.WithPlugin(replacement))
	var sdkErr *modular.Error
	if !errors.As(err, &sdkErr) || sdkErr.Code != modular.InvalidComposition {
		t.Fatalf("invalid replacement: %v", err)
	}
}

func hooksPlugin() modular.Plugin {
	return modular.Plugin{Name: "extra", Setup: func(r *modular.Registrar) error {
		if err := r.OnTurnBefore(func(context.Context, modular.TurnBefore) (modular.TurnContribution, error) {
			return modular.TurnContribution{System: "Use the tide."}, nil
		}); err != nil {
			return err
		}
		if err := r.OnToolAfter(func(_ context.Context, in modular.ToolAfter) (modular.ToolChange, error) {
			content := modular.Text(in.Result.Text() + " Checked.")
			return modular.ToolChange{Content: &content}, nil
		}); err != nil {
			return err
		}
		if err := r.OnStepAfter(func(_ context.Context, in modular.StepAfter) (modular.StepDecision, error) {
			if in.Response.Content.Text() == "blocked" {
				return modular.StepDecision{End: "stop here"}, nil
			}
			return modular.StepDecision{}, nil
		}); err != nil {
			return err
		}
		if err := r.OnTurnEnd(func(context.Context, modular.TurnEnd) error { return nil }); err != nil {
			return err
		}
		return r.Command(modular.Command{Name: "repeat", Description: "Return the arguments.", Run: func(_ context.Context, args string, _ *modular.CommandContext) (string, error) { return args, nil }})
	}}
}

func TestSDKHookChild(t *testing.T) {
	for i, arg := range os.Args {
		if arg == "--" && i+1 < len(os.Args) && os.Args[i+1] == "sdk-hook-child" {
			if err := modular.Serve(context.Background(), hooksPlugin()); err != nil {
				os.Exit(1)
			}
			os.Exit(0)
		}
	}
}

func TestHooksAndCommandsInBothPlacements(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct {
		name   string
		option modular.Option
	}{
		{"inProcess", modular.WithPlugin(hooksPlugin())},
		{"process:go", modular.WithProcessPlugin(modular.ProcessPlugin{Command: []string{exe, "-test.run=^TestSDKHookChild$", "--", "sdk-hook-child"}})},
	} {
		t.Run(p.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			a := modulartest.Agent(t, p.option, modular.WithTool(Tide), modulartest.Script(`[{"toolCalls":[{"name":"tide","input":{"harbour":"Whitby"}}]},{"text":"blocked"}]`))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			cmd, err := s.RunCommand(ctx, `/repeat  a "b  c" `)
			if err != nil || cmd != ` a "b  c" ` {
				t.Fatalf("command: %q %v", cmd, err)
			}
			got, err := s.Prompt(ctx, "tide")
			if err != nil {
				t.Fatal(err)
			}
			if got.Outcome == nil || got.Outcome.Kind != "failed" || !strings.Contains(got.Outcome.Error, "stop here") {
				t.Fatalf("want step gate refusal: %#v", got.Outcome)
			}
			if results := got.ToolResults(); len(results) != 1 || results[0].Text() != "High tide at Whitby is 14:02. Checked." {
				t.Fatal(results)
			}
			entries, err := s.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := json.Marshal(entries)
			if !strings.Contains(string(b), "Use the tide.") {
				t.Fatalf("turn.before contribution missing: %s", b)
			}
		})
	}
}
