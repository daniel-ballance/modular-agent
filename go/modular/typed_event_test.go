package modular_test

import (
	"context"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestTypedEventsForSessionActions(t *testing.T) {
	ctx := t.Context()
	a := modulartest.Agent(t, modular.WithSeveralActors(true), modulartest.Script(`[{"text":"done", "usage":{"input":3,"output":1}}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Drive the actions after the iterator has subscribed, without polling.
	changed, ended := false, false
	for e, err := range s.Events(ctx) {
		if err != nil {
			t.Fatal(err)
		}
		if !changed && e.Header().Type == "entry" {
			changed = true
			if err := s.SetSetting(ctx, "maxSteps", 5); err != nil {
				t.Fatal(err)
			}
			if err := s.Close(ctx); err != nil {
				t.Fatal(err)
			}
		}
		if v, ok := e.(modular.TypedEvent[modular.SettingData]); ok && v.Data.Key == "maxSteps" {
			if v.Data.Value != float64(5) {
				t.Errorf("setting event value: %v", v.Data.Value)
			}
		}
		if v, ok := e.(modular.TypedEvent[modular.SessionData]); ok && v.Type == "sessionEnded" {
			ended = v.Data.SessionID == s.ID()
			break
		}
	}
	if !changed || !ended {
		t.Fatal("missing session events")
	}
	// A fresh session verifies the typed turn lifecycle, including accounted usage.
	s, err = a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for e, err := range s.PromptStream(ctx, "hello") {
		if err != nil {
			t.Fatal(err)
		}
		switch x := e.(type) {
		case modular.TypedEvent[modular.TurnStartedData]:
			seen["turn"] = x.Data.TurnID != ""
		case modular.TypedEvent[modular.StepStartedData]:
			seen["step"] = x.Data.StepID != ""
		case modular.TypedEvent[modular.StepEndedData]:
			seen["stepEnd"] = x.Data.StepID != "" && x.Data.Usage.Input == 3
		case modular.EndEvent:
			seen["end"] = x.TurnID != ""
		}
	}
	for _, typ := range []string{"turn", "step", "stepEnd", "end"} {
		if !seen[typ] {
			t.Errorf("missing typed %s", typ)
		}
	}
}

func TestIllegalHookTransformsDoNotChangeInputOrDispatch(t *testing.T) {
	for _, remote := range []bool{false, true} {
		name := "inProcess"
		if remote {
			name = "overWire"
		}
		t.Run(name, func(t *testing.T) {
			for _, point := range []string{"input", "step.before", "provider.request"} {
				t.Run(point, func(t *testing.T) {
					p := modular.Plugin{Name: "bad-transform", Setup: func(r *modular.Registrar) error {
						return r.On(point, func(_ context.Context, p modular.HookPayload) (modular.HookAnswer, error) {
							if point == "input" {
								p["when"] = "after"
							} else {
								p["sessionId"] = "different-session"
							}
							return modular.HookAnswer{"value": p}, nil
						})
					}}
					opt := modular.WithPlugin(p)
					if remote {
						opt = modulartest.OverWire(p)
					}
					a := modulartest.Agent(t, opt, modulartest.Script(`[{"text":"must not be delivered"}]`))
					s, err := a.Session(t.Context())
					if err != nil {
						t.Fatal(err)
					}
					result, err := s.Prompt(t.Context(), "test")
					if err == nil && (result.Outcome == nil || result.Outcome.Kind != "failed" || result.Text != "") {
						t.Fatalf("illegal transform survived: %+v", result)
					}
				})
			}
		})
	}
}
