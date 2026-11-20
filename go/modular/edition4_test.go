package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestNestedToolsInBothPlacements(t *testing.T) {
	for _, wire := range []bool{false, true} {
		name := "in-process"
		if wire {
			name = "wire"
		}
		t.Run(name, func(t *testing.T) {
			saved := make(chan modular.ToolCalls, 1)
			child := modular.NewTool("child", "child", func(_ context.Context, _ struct{}, _ *modular.ToolContext) (string, error) {
				return "child secret", nil
			}, modular.Callers("plugin"))
			parent := modular.NewTool("parent", "parent", func(ctx context.Context, _ struct{}, c *modular.ToolContext) (string, error) {
				saved <- c.Tools
				defs, err := c.Tools.List(ctx)
				if err != nil {
					return "", err
				}
				if !slices.ContainsFunc(defs, func(d modular.ToolDefinition) bool { return d.Name == "child" }) {
					return "", errors.New("missing child")
				}
				for _, name := range []string{"absent", "child"} {
					result, err := c.Tools.Call(ctx, name, struct{}{})
					if err != nil {
						return "", err
					}
					if (name == "absent" && result.Status != modular.Refused) || (name == "child" && result.Text() != "child secret") {
						return "", errors.New("unexpected nested result")
					}
				}
				return "parent only", nil
			})
			hidden := modular.NewTool("hidden", "model-only but withheld", func(context.Context, struct{}, *modular.ToolContext) (string, error) { return "hidden", nil }, modular.Callers("model"))
			plugin := modular.Plugin{Name: "nested", Setup: func(r *modular.Registrar) error { return errors.Join(r.Tool(parent), r.Tool(child), r.Tool(hidden)) }}
			placement := modular.WithPlugin(plugin)
			if wire {
				placement = modulartest.OverWire(plugin)
			}
			model := modulartest.ScriptedProvider(nil)
			model.Request = func(_ context.Context, _ modular.ModelRef, r modular.ModelRequest, _ *modular.ProviderContext) (modular.AssistantMessage, error) {
				if len(r.Tools) != 1 || r.Tools[0].Name != "parent" {
					return modular.AssistantMessage{}, errors.New("wrong tool offer")
				}
				b, _ := json.Marshal(r.Messages)
				if strings.Contains(string(b), "child secret") {
					return modular.AssistantMessage{}, errors.New("nested result leaked to model")
				}
				if strings.Contains(string(b), "parent only") {
					return modular.AssistantMessage{Content: modular.Text("done"), Stop: "finished"}, nil
				}
				return modular.AssistantMessage{Stop: "toolUse", Content: modular.Content{{Type: "toolCall", Fields: map[string]json.RawMessage{"id": json.RawMessage(`"parent-call"`), "name": json.RawMessage(`"parent"`), "arguments": json.RawMessage(`{}`)}}}}, nil
			}
			ctx := t.Context()
			a := modulartest.Agent(t, modular.WithProvider(model), placement, modular.WithSettings(modular.Settings{"modelTools": []string{"parent"}}))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.Prompt(ctx, "run")
			if err != nil || r.Text != "done" {
				t.Fatalf("%+v %v %v", r, err, r.ToolResults())
			}
			if results := r.ToolResults(); len(results) != 1 || results[0].Name != "parent" || results[0].Text() != "parent only" {
				t.Fatalf("want only the model's call, got %+v", results)
			}
			calls := <-saved
			if _, err = calls.List(ctx); err == nil {
				t.Fatal("settled tool context still active")
			}
			history, err := s.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(history)
			if !strings.Contains(string(raw), `"parentCallId":"parent-call"`) || !strings.Contains(string(raw), `"startedBy":"tool"`) {
				t.Fatalf("missing nested lineage: %s", raw)
			}
		})
	}
}

func TestNestedCancellationAndRecovery(t *testing.T) {
	for _, mode := range []string{"cancel", "restart"} {
		t.Run(mode, func(t *testing.T) {
			ctx, stop := context.WithTimeout(t.Context(), 5*time.Second)
			defer stop()
			entered := make(chan struct{}, 1)
			child := modular.NewTool("child", "child", func(ctx context.Context, _ struct{}, _ *modular.ToolContext) (string, error) {
				entered <- struct{}{}
				<-ctx.Done()
				return "", ctx.Err()
			})
			parent := modular.NewTool("parent", "parent", func(ctx context.Context, _ struct{}, c *modular.ToolContext) (string, error) {
				r, err := c.Tools.Call(ctx, "child", struct{}{})
				return r.Text(), err
			})
			a := modulartest.Agent(t, modular.WithTool(parent), modular.WithTool(child), modulartest.Script(`[{"toolCalls":[{"name":"parent","input":{}}]},{"text":"done"}]`))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			promptCtx, cancelPrompt := context.WithCancel(ctx)
			defer cancelPrompt()
			go func() { defer close(done); _, _ = s.Prompt(promptCtx, "run") }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var want string
			if mode == "restart" {
				fresh := modulartest.Restart(t, a)
				cancelPrompt()
				<-done
				s, err = fresh.OpenSession(ctx, s.ID())
				want = "outcomeUnknown"
			} else {
				_, err = s.Cancel(ctx)
				<-done
				want = "cancelled"
			}
			if err != nil {
				t.Fatal(err)
			}
			history, err := s.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(history)
			var rows []map[string]any
			if err := json.Unmarshal(encoded, &rows); err != nil {
				t.Fatal(err)
			}
			var childID, parentID string
			for _, e := range rows {
				if e["kind"] != "toolStarted" {
					continue
				}
				data, _ := e["data"].(map[string]any)
				call, _ := data["call"].(map[string]any)
				if call["name"] == "child" {
					childID, _ = call["id"].(string)
					parentID, _ = call["parentCallId"].(string)
				}
			}
			n := 0
			for _, e := range rows {
				if e["kind"] != "toolResult" {
					continue
				}
				if e["toolCallId"] == parentID && n != 1 {
					t.Fatal("parent settled before its child")
				}
				if e["toolCallId"] == childID {
					n++
					data, _ := e["data"].(map[string]any)
					if data["status"] != want || e["modelVisible"] != false {
						t.Fatalf("nested result: %v", e)
					}
				}
			}
			if n != 1 {
				t.Fatalf("nested settlements: %d", n)
			}
		})
	}
}

func TestStructuredResultEventsAndRestart(t *testing.T) {
	ctx := t.Context()
	a := modulartest.Agent(t, modulartest.Script(`[{"text":"{\"name\":\"Whitby\"}"}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	schema := json.RawMessage(`{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}`)
	r, err := s.Prompt(ctx, "harbour", modular.WithResult(schema))
	if err != nil || string(r.Value) != `{"name":"Whitby"}` {
		t.Fatalf("%+v %v", r, err)
	}
	history, err := s.History(ctx)
	if err != nil || len(history) < 2 {
		t.Fatalf("%v %v", history, err)
	}
	cursor := history[len(history)-2]["id"].(string)
	var got bool
	for ev, err := range s.Events(ctx, cursor) {
		if err != nil || ev.Header().Type != "entry" {
			t.Fatalf("%v %v", ev, err)
		}
		b, _ := json.Marshal(ev)
		if !strings.Contains(string(b), history[len(history)-1]["id"].(string)) {
			t.Fatalf("wrong cursor: %s", b)
		}
		got = true
		break
	}
	if !got {
		t.Fatal("missing replay")
	}
	fresh := modulartest.Restart(t, a)
	s, err = fresh.OpenSession(ctx, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	last, err := s.LastTurn(ctx)
	if err != nil || last == nil || string(last.Value) != string(r.Value) {
		t.Fatalf("%+v %v", last, err)
	}
}

func TestEventsLagReportsReplayCursor(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	model := modulartest.ScriptedProvider(nil)
	model.Request = func(_ context.Context, _ modular.ModelRef, _ modular.ModelRequest, p *modular.ProviderContext) (modular.AssistantMessage, error) {
		for range 400 {
			p.Piece("text", ".")
		}
		return modular.AssistantMessage{Content: modular.Text("done"), Stop: "finished"}, nil
	}
	a := modulartest.Agent(t, modular.WithProvider(model))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var lag *modular.Error
	first := true
	for _, err = range s.Events(ctx) {
		if err != nil {
			if !errors.As(err, &lag) || lag.Code != modular.Lost {
				t.Fatal(err)
			}
			break
		}
		if first {
			first = false
			if _, err := s.Prompt(ctx, "burst of deltas"); err != nil {
				t.Fatal(err)
			}
		}
	}
	if lag == nil {
		t.Fatal("expected lag")
	}
	cursor, ok := lag.Data["fromEntry"].(string)
	if !ok || cursor == "" {
		t.Fatalf("missing replay cursor: %v", lag.Data)
	}
	for event, err := range s.Events(ctx, cursor) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Header().Type != "entry" {
			t.Fatal(event)
		}
		b, _ := json.Marshal(event)
		var wire struct {
			Data struct{ Entry struct{ ID string } }
		}
		if err := json.Unmarshal(b, &wire); err != nil {
			t.Fatal(err)
		}
		if wire.Data.Entry.ID == cursor {
			t.Fatal("replayed the cursor entry")
		}
		return
	}
	t.Fatal("no entries after lag cursor")
}

func TestMemoryEnvironment(t *testing.T) {
	ctx := t.Context()
	env := modulartest.MemoryEnvironment(map[string][]byte{"dir/file": []byte("contents")})
	a := modulartest.Agent(t, modulartest.Script(`[{"text":"offline"}]`), modular.WithEnvironment(env))
	if a.Declaration()["confinesFiles"] != true || a.Declaration()["commandContainment"] != "none" {
		t.Fatal(a.Declaration())
	}
	if _, err := env.Read(ctx, "/root", "../outside"); !errors.Is(err, fs.ErrPermission) {
		t.Fatal(err)
	}
	if list, err := env.ListDir(ctx, "/root", "."); err != nil || len(list) != 1 || list[0].Kind != "directory" {
		t.Fatalf("%v %v", list, err)
	}
	if _, err := env.Bash(ctx, "/root", "unknown", nil); err == nil {
		t.Fatal("unregistered command ran")
	}
	env.OnExec("echo", func(_ context.Context, command string, _ func(string)) (modular.ExecResult, error) {
		zero := 0
		return modular.ExecResult{Output: command, ExitCode: &zero}, nil
	})
	if text, err := env.Bash(ctx, "/root", "echo yes", nil); err != nil || text != "echo yes" {
		t.Fatalf("%q %v", text, err)
	}
}
