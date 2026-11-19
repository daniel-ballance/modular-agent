package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/OWNER/modular-agent/go/modular"
	"github.com/OWNER/modular-agent/go/modular/modulartest"
)

func TestProviderAdmissionAndFailureInBothPlacements(t *testing.T) {
	for _, wire := range []bool{false, true} {
		name := "inProcess"
		if wire {
			name = "wire"
		}
		t.Run(name, func(t *testing.T) {
			p := modulartest.ScriptedProvider(nil)
			var requests atomic.Int32
			p.Request = func(context.Context, modular.ModelRef, modular.ModelRequest, *modular.ProviderContext) (modular.AssistantMessage, error) {
				requests.Add(1)
				return modular.AssistantMessage{}, errors.New("ordinary provider failure")
			}
			opt := modular.WithProvider(p)
			if wire {
				opt = modulartest.OverWire(modular.Plugin{Name: "provider", Setup: func(r *modular.Registrar) error { return r.Provider(p) }})
			}
			ctx := t.Context()
			_, err := modular.New(ctx, opt, modular.WithModel("scripted/unknown"))
			assertCode(t, err, modular.InvalidRequest)
			a := modulartest.Agent(t, opt)
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			assertCode(t, s.SetSetting(ctx, "model", "scripted/unknown"), modular.InvalidRequest)
			if requests.Load() != 0 {
				t.Fatal("unknown model reached provider")
			}
			result, err := s.Prompt(ctx, "offline")
			if err != nil || result.Outcome == nil || result.Outcome.Kind != "failed" || result.Outcome.Error != "ordinary provider failure" {
				t.Fatalf("prompt: %+v, outcome: %+v, %v", result, result.Outcome, err)
			}
			history, err := s.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.ContainsFunc(history, func(e modular.HistoryEntry) bool {
				b, _ := json.Marshal(e)
				return e["kind"] == "response" && strings.Contains(string(b), `"kind":"other","message":"ordinary provider failure"`) && strings.Contains(string(b), `"stop":"failed"`)
			}) {
				t.Fatalf("missing failed assistant message: %v", history)
			}
		})
	}
}

func TestUnknownModelRemovedBeforeAdmission(t *testing.T) {
	p := modulartest.ScriptedProvider(nil)
	catalog := p.Models
	var removed atomic.Bool
	p.Models = func() []modular.ModelInfo {
		if removed.Load() {
			return nil
		}
		return catalog()
	}
	a := modulartest.Agent(t, modular.WithProvider(p))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	removed.Store(true)
	_, err = s.Prompt(t.Context(), "don't admit")
	assertCode(t, err, modular.InvalidRequest)
	history, err := s.History(t.Context())
	if err != nil || slices.ContainsFunc(history, func(e modular.HistoryEntry) bool { return e["kind"] == "inputAccepted" }) {
		t.Fatalf("unknown model input was admitted: %v, %v", history, err)
	}
}

func TestStructuredResultRefusalRetriesUntilValidNull(t *testing.T) {
	a := modulartest.Agent(t, modulartest.Script("[{\"text\":\"```json\\nnull\\n```\"},{\"text\":\"42\"},{\"text\":\"null\"}]"))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.Prompt(t.Context(), "return nothing", modular.WithResult(json.RawMessage(`{"type":"null"}`)))
	if err != nil || result.Outcome == nil || result.Outcome.Kind != "completed" || string(result.Value) != "null" {
		t.Fatalf("prompt: %+v, %v", result, err)
	}
	history, err := s.History(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	feedback := 0
	for _, e := range history {
		if e["kind"] == "resultFeedback" {
			feedback++
		}
	}
	if feedback != 2 {
		t.Fatalf("want two result refusals, got %d", feedback)
	}
}

func TestDeclarationUsesSelectedParts(t *testing.T) {
	for _, durability := range []modular.Durability{modular.Ephemeral, modular.Kept, modular.Durable} {
		t.Run(string(durability), func(t *testing.T) {
			opts := []modular.Option{modular.WithDurability(durability)}
			if durability != modular.Ephemeral {
				opts = append(opts, modular.WithHistory(modular.FileHistory(t.TempDir())))
			}
			a := modulartest.Agent(t, opts...)
			d := a.Declaration()
			if d["erasure"] != true || d["portableSessions"] != (durability != modular.Ephemeral) || d["continuesAfterRestart"] != (durability == modular.Durable) ||
				d["confinesFiles"] != true || d["commandContainment"] != "none" || d["nestedToolCalls"] != true || d["settingsDuringTurn"] != "nextTurn" || d["queuedInputAfterRestart"] != "handedBack" {
				t.Fatal(d)
			}
			if _, ok := d["queuedJobReportsAfterRestart"]; ok {
				t.Fatal("redundant queued job report policy", d)
			}
		})
	}
}

func assertCode(t *testing.T, err error, code modular.Code) {
	t.Helper()
	var e *modular.Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
