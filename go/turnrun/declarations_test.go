package turnrun_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/local"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func seed(t *testing.T, root string, entries ...api.Entry) string {
	t.Helper()
	s := api.Session{ID: api.ID(), Version: 1, Project: root, Actor: "local-user", Settings: api.Settings{Model: "fake", Thinking: "off", MaxSteps: 4, MaxOutput: 100}, Plugins: []string{"transient"}}
	for _, e := range entries {
		e.ID = api.ID()
		e.Parent = s.Position
		e.Session = s.ID
		e.Writer = "fixture"
		e.Actor = s.Actor
		e.Time = time.Now().UTC()
		s.Position = e.ID
		s.Entries = append(s.Entries, e)
	}
	store, err := history.New(filepath.Join(root, "history"))
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.Acquire(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = lease.Save(s); err != nil {
		t.Fatal(err)
	}
	if err = lease.Close(); err != nil {
		t.Fatal(err)
	}
	return s.ID
}
func turnStart(tools []api.Tool) api.Entry {
	return api.Entry{Kind: "turn.start", Turn: "original-turn", Data: api.JSON(api.TurnStart{Input: "initial", Settings: api.Settings{Model: "fake", Thinking: "off", MaxSteps: 4, MaxOutput: 100}, Tools: tools})}
}
func wait(t *testing.T, a api.API, id string) api.Outcome {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := a.Open(ctx, id); err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type unsafeTools struct{ effectTools }

func (s unsafeTools) Tools(session api.Session) []api.Tool {
	out := s.effectTools.Tools(session)
	for i := range out {
		out[i].SafeRepeat = false
	}
	return out
}

type untracked struct{ *local.Environment }

func (untracked) StopsOnCrash() bool { return false }

func TestRecoveryNeverGuessesRepeatSafety(t *testing.T) {
	for _, scenario := range []string{"recorded-unsafe", "currently-unsafe", "environment-unsafe", "tool-missing"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			source := effectTools{root: root}
			defs := source.Tools(api.Session{})
			if scenario == "recorded-unsafe" {
				for i := range defs {
					defs[i].SafeRepeat = false
				}
			}
			call := api.Call{ID: "safe", Name: "safe", Input: api.JSON(map[string]string{})}
			id := seed(t, root, turnStart(defs), api.Entry{Kind: "model.request", Turn: "original-turn", Step: "step", TracksStepAfter: true}, api.Entry{Kind: "model", Turn: "original-turn", Step: "step", Visible: true, Content: api.Content{{Type: "tool_call", Call: &call}}, Data: api.JSON(map[string]any{"Stop": "tools", "Usage": api.Usage{Input: 1}})}, api.Entry{Kind: "tool.call", Turn: "original-turn", Step: "step", Call: "safe", Data: api.JSON(call)}, api.Entry{Kind: "tool.started", Turn: "original-turn", Step: "step", Call: "safe", Data: api.JSON(call)})
			p := fake.New(fake.Script{Require: "outcome is unknown", Response: api.Response{Stop: "finished", Content: api.Text("checked")}})
			h, err := vanilla.New(fakeOptions(root, p, true))
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			if scenario != "tool-missing" {
				var tools api.ToolSource = source
				if scenario == "currently-unsafe" {
					tools = unsafeTools{source}
				}
				if err = h.Load(api.Plugin{Name: "effects", Setup: func(a api.API) error { return a.Provide("tools.effects", tools) }}); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "environment-unsafe" {
				env := untracked{local.NewAt(filepath.Join(root, "untracked"))}
				if err = h.Load(api.Plugin{Name: "untracked", Replaces: "local", Setup: func(a api.API) error { return a.Provide("working-environment", env) }, Close: env.Close}); err != nil {
					t.Fatal(err)
				}
			}
			out := wait(t, h.API(), id)
			if out.Status != "completed" {
				t.Fatal(out)
			}
			if _, err = os.Stat(filepath.Join(root, "effects")); !os.IsNotExist(err) {
				t.Fatal("uncertain call repeated", err)
			}
			snap, _ := h.API().Snapshot(id)
			foundDurable := false
			for _, name := range snap.Plugins {
				if name == "durable" {
					foundDurable = true
				}
				if name == "transient" {
					t.Fatal("active plugin declaration stale")
				}
			}
			if !foundDurable {
				t.Fatal(snap.Plugins)
			}
		})
	}
}

type declaredProvider struct {
	*fake.Provider
	stateful, tools bool
}

func (p declaredProvider) Catalog() []api.Model {
	out := p.Provider.Catalog()
	for i := range out {
		out[i].Stateful = p.stateful
		out[i].RunsTools = p.tools
	}
	return out
}
func (p declaredProvider) Access(id string) (api.ModelAccess, error) {
	a, err := p.Provider.Access(id)
	if err != nil {
		return nil, err
	}
	return declaredAccess{a, p.stateful, p.tools}, nil
}

type declaredAccess struct {
	api.ModelAccess
	stateful, tools bool
}

func (a declaredAccess) Model() api.Model {
	m := a.ModelAccess.Model()
	m.Stateful = a.stateful
	m.RunsTools = a.tools
	return m
}
func TestInterruptedEffectfulModelRequestIsNotRepeated(t *testing.T) {
	for _, scenario := range []string{"stateful", "provider-tools"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			id := seed(t, root, turnStart(nil), api.Entry{Kind: "step.start", Turn: "original-turn", Step: "request"})
			p := fake.New()
			declared := declaredProvider{p, scenario == "stateful", scenario == "provider-tools"}
			opt := fakeOptions(root, p, true)
			opt.Provider = api.Plugin{Name: "declared-fake", Setup: func(a api.API) error { return a.Provide("provider.fake", declared) }}
			h, err := vanilla.New(opt)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			out := wait(t, h.API(), id)
			if out.Status != "failed" || !strings.Contains(out.Error, "unknown outside effects") || len(p.Requests()) != 0 {
				t.Fatal(out, p.Requests())
			}
		})
	}
}

func TestIntakeAndSteeringSurviveReopen(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, scenario := range []string{"accepted", "taken-before-start", "queued-steering", "taken-steering", "queued-follow-up"} {
			t.Run(scenario, func(t *testing.T) {
				root := t.TempDir()
				in := api.Input{ID: "initial", Key: "initial-key", Actor: "local-user", When: "now", Content: api.Text("initial direction")}
				entries := []api.Entry{{Kind: "input.accepted", Content: in.Content, Data: api.JSON(in)}}
				if scenario != "accepted" {
					entries = append(entries, api.Entry{Kind: "input", Visible: true, Content: in.Content, Data: api.JSON(in.ID)})
				}
				if scenario != "accepted" && scenario != "taken-before-start" {
					entries = append(entries, turnStart(nil), api.Entry{Kind: "model.request", Turn: "original-turn", Step: "first", TracksStepAfter: true}, api.Entry{Kind: "model", Turn: "original-turn", Step: "first", Visible: true, Content: api.Text("old answer"), Data: api.JSON(map[string]any{"Stop": "finished"})})
					steer := api.Input{ID: "steer", Key: "steer-key", Actor: "local-user", When: "steer", Content: api.Text("new direction")}
					if scenario == "queued-follow-up" {
						steer.When = "after"
					}
					entries = append(entries, api.Entry{Kind: "input.accepted", Content: steer.Content, Data: api.JSON(steer)})
					if scenario == "taken-steering" {
						entries = append(entries, api.Entry{Kind: "input", Visible: true, Content: steer.Content, Data: api.JSON(steer.ID)})
					}
				}
				id := seed(t, root, entries...)
				require := "initial direction"
				if scenario == "queued-steering" || scenario == "taken-steering" || scenario == "queued-follow-up" {
					require = "new direction"
				}
				p := fake.New(fake.Script{Require: require, Response: api.Response{Stop: "finished", Content: api.Text("fresh answer")}})
				opt := fakeOptions(root, p, false)
				opt.Runtime = runtimetest.Plugin(t)
				h, err := vanilla.New(opt)
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				out := wait(t, h.API(), id)
				wantsFailure := opt.Runtime.Name == "transient" && scenario == "taken-steering"
				if wantsFailure {
					if out.Status != "failed" {
						t.Fatal(out)
					}
				} else if out.Status != "completed" || out.Result.Text() != "fresh answer" {
					t.Fatal(out)
				}
				snap, _ := h.API().Snapshot(id)
				taken := 0
				for _, e := range snap.Entries {
					if e.Kind == "input" && api.Decode[string](e.Data) == "initial" {
						taken++
					}
				}
				if taken != 1 {
					t.Fatal("input taken more than once", taken)
				}
				receipt, err := h.API().Submit(context.Background(), id, api.Input{Key: "initial-key", Content: api.Text("retry")})
				if err != nil || !receipt.Duplicate {
					t.Fatal(receipt, err)
				}
			})
		}
	})
}
