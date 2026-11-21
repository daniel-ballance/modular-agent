package modular_test

import (
	"context"
	"errors"
	"io/fs"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type localSettings struct{}

func (localSettings) Settings(string) (modular.Settings, error) {
	return modular.Settings{"reasoning": "low"}, nil
}
func (localSettings) Trusted(string) (bool, error) { return true, nil }

type localCredential struct{}

func (localCredential) Get(context.Context, string) (string, error) { return "fake-only", nil }

type localFront struct {
	agent   *modular.Agent
	stopped bool
}

func (f *localFront) Start(_ context.Context, a *modular.Agent) error { f.agent = a; return nil }
func (f *localFront) Stop() error                                     { f.stopped = true; return nil }

type localStore struct {
	record   *modular.SessionRecord
	acquired bool
}

func (s *localStore) Acquire(string) (modular.HistoryLease, error) { s.acquired = true; return s, nil }
func (s *localStore) List(string) ([]modular.SessionRecord, error) {
	if s.record == nil {
		return nil, nil
	}
	return []modular.SessionRecord{*s.record}, nil
}
func (s *localStore) Erase([]string) error { return nil }
func (s *localStore) Load() (modular.SessionRecord, error) {
	if s.record == nil {
		return modular.SessionRecord{}, fs.ErrNotExist
	}
	return *s.record, nil
}
func (s *localStore) Save(r modular.SessionRecord) error { s.record = &r; return nil }
func (s *localStore) Close() error                       { return nil }

func TestLocalRegistrarParts(t *testing.T) {
	ctx := t.Context()
	store, front := &localStore{}, &localFront{}
	p := modulartest.ScriptedProvider(nil)
	catalog := p.Models
	p.Models = func() []modular.ModelInfo { models := catalog(); models[0].Thinking = []string{"low"}; return models }
	p.Request = func(_ context.Context, _ modular.ModelRef, r modular.ModelRequest, c *modular.ProviderContext) (modular.AssistantMessage, error) {
		key, err := c.Credential()
		if err != nil || key != "fake-only" || r.Settings["reasoning"] != "low" {
			return modular.AssistantMessage{}, errors.New("registered parts were not applied")
		}
		return modular.AssistantMessage{Stop: "finished", Content: modular.Text("ready")}, nil
	}
	plugin := func(persistent bool) modular.Plugin {
		return modular.Plugin{Name: "custom-parts", Replaces: []string{"history", "credentials", "configuration", "runtime", "working-environment"}, Setup: func(r *modular.Registrar) error {
			return errors.Join(r.HistoryStore(modular.NewHistoryStore(store, persistent, true)), r.CredentialStore(localCredential{}), r.Configuration(localSettings{}), r.Interface(front), r.Runtime(modular.TransientRuntime()), r.Environment(modulartest.MemoryEnvironment(nil)))
		}}
	}
	_, err := modular.New(ctx, modular.WithPlugin(plugin(true)))
	assertCode(t, err, modular.InvalidComposition)
	a := modulartest.Agent(t, modular.WithProvider(p), modular.WithPlugin(plugin(false)))
	if front.agent != a {
		t.Fatal("custom Interface was not started")
	}
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := s.Prompt(ctx, "Hello")
	if err != nil || turn.Text != "ready" {
		t.Fatalf("prompt: %+v %v", turn, err)
	}
	if !store.acquired || store.record == nil {
		t.Fatal("custom history did not commit the turn")
	}
	if err = a.Close(ctx); err != nil || !front.stopped {
		t.Fatalf("interface did not stop: %v", err)
	}
}

func TestPendingGateResumesAndUsesTypedEvents(t *testing.T) {
	ctx := t.Context()
	tool := modular.NewTool("check", "Perform a check.", func(context.Context, struct{}, *modular.ToolContext) (string, error) { return "passed", nil })
	p := modular.Plugin{Name: "pending-gate", Setup: func(r *modular.Registrar) error {
		return r.OnToolBefore(func(context.Context, modular.ToolBefore) (modular.Gate, error) {
			return modular.Gate{Pending: &modular.Question{Kind: "text", Question: "Continue?"}}, nil
		}, modular.HookInProcessOnly())
	}}
	a := modulartest.Agent(t, modular.WithTool(tool), modular.WithPlugin(p), modular.WithLateAnswersStartTurns(true), modulartest.Script(`[{"toolCalls":[{"name":"check","input":{}}]},{"text":"done"}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var requested bool
	for event, err := range s.PromptStream(ctx, modular.Text("check")) {
		if err != nil {
			t.Fatal(err)
		}
		if call, ok := event.(modular.TypedEvent[modular.ToolCallData]); ok && call.Header().Type == "toolCall" {
			requested = call.Data.Call.Name == "check"
		}
	}
	if !requested {
		t.Fatal("no typed requested call")
	}
	qs, err := s.Questions(ctx)
	if err != nil || len(qs) != 1 {
		t.Fatalf("open questions: %+v %v", qs, err)
	}
	if err = s.Answer(ctx, qs[0].ID, modular.Value("yes")); err != nil {
		t.Fatal(err)
	}
	if err = s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	history, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range history {
		if e["kind"] == "toolResult" {
			return
		}
	}
	t.Fatal("answer did not settle the pending tool call")
}
