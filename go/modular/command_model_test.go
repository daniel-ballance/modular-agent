package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestCommandAuxiliaryRequests(t *testing.T) {
	p := modulartest.ScriptedProvider(nil)
	p.Request = func(_ context.Context, _ modular.ModelRef, request modular.ModelRequest, c *modular.ProviderContext) (modular.AssistantMessage, error) {
		if request.SystemPrompt != "transformed" {
			return modular.AssistantMessage{}, errors.New("missing Provider transform")
		}
		c.Piece("text", "auxiliary")
		return modular.AssistantMessage{Role: "assistant", Stop: "toolUse", Usage: modular.Usage{Input: 5, Output: 3}, Content: modular.Content{{Type: "toolCall", Fields: map[string]json.RawMessage{"id": json.RawMessage(`"not-dispatched"`), "name": json.RawMessage(`"unavailable"`), "arguments": json.RawMessage(`{}`)}}}}, nil
	}
	var saved *modular.CommandContext
	var requests, responses, pieces int
	plug := modular.Plugin{Name: "auxiliary", Setup: func(r *modular.Registrar) error {
		return errors.Join(r.Command(modular.Command{Name: "aux", Description: "Make auxiliary requests.", UsesModel: true, Run: func(ctx context.Context, _ string, c *modular.CommandContext) (string, error) {
			saved = c
			for range 2 {
				message, err := c.RequestModel(ctx, modular.ModelRequest{Messages: []modular.Message{{Role: "user", Content: modular.Text("summarize")}}})
				if err != nil {
					return "", err
				}
				if message.Stop != "toolUse" || len(message.Content) != 1 || message.Content[0].Type != "toolCall" {
					return "", errors.New("command did not receive returned tool call")
				}
			}
			return "done", nil
		}}), r.OnProviderRequest(func(_ context.Context, p modular.ProviderRequest) (*modular.ModelRequest, error) {
			requests++
			p.Request.SystemPrompt = "transformed"
			return &p.Request, nil
		}), r.OnProviderResponse(func(context.Context, modular.ProviderResponse) error { responses++; return nil }),
			r.OnProviderPiece(func(_ context.Context, p modular.ProviderPiece) error {
				if p.Piece.Text == "auxiliary" && p.StepID != "" {
					pieces++
				}
				return nil
			}))
	}}
	a := modulartest.Agent(t, modular.WithProvider(p), modular.WithPlugin(plug))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.RunCommand(t.Context(), "/aux")
	if err != nil || out != "done" {
		t.Fatalf("command: %q %v", out, err)
	}
	if requests != 2 || responses != 2 || pieces != 2 {
		t.Fatalf("Provider hooks: %d / %d / %d", requests, responses, pieces)
	}
	if _, err = saved.RequestModel(t.Context(), modular.ModelRequest{}); err == nil {
		t.Fatal("settled context allowed dispatch")
	} else {
		assertCode(t, err, modular.InvalidRequest)
	}
	if turn, err := s.LastTurn(t.Context()); err != nil || turn != nil {
		t.Fatalf("unexpected turn: %v %v", turn, err)
	}
	entries, err := s.History(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	var intent any
	var settled int
	for _, e := range entries {
		switch e["kind"] {
		case "modelRequest":
			if e["stepId"] != saved.StepID || e["turnId"] != nil {
				t.Fatalf("model request: %v", e)
			}
			intent = e["id"]
		case "response":
			var sources []string
			raw, _ := json.Marshal(e["sources"])
			_ = json.Unmarshal(raw, &sources)
			if len(sources) != 1 || sources[0] != intent || e["stepId"] != saved.StepID || e["turnId"] != nil {
				t.Fatalf("response: %v", e)
			}
			settled++
		case "toolStarted", "turnStart":
			t.Fatalf("unexpected dispatch: %v", e)
		}
	}
	if settled != 2 {
		t.Fatalf("settled requests: %d", settled)
	}
}
