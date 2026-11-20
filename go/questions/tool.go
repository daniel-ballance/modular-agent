package questions

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"time"
)

func (m *Manager) Tools(api.Session) []api.Tool {
	return []api.Tool{{Name: "ask_user", Description: "Ask the user for text, a choice, or a secret stored under a credential name. A timed-out deferred question remains open.", SafeRepeat: true, Input: api.JSON(map[string]any{"type": "object", "properties": map[string]any{"kind": map[string]string{"type": "string"}, "question": map[string]string{"type": "string"}, "options": map[string]any{"type": "array", "items": map[string]string{"type": "string"}}, "credential": map[string]string{"type": "string"}, "wait_ms": map[string]string{"type": "integer"}, "defer": map[string]string{"type": "boolean"}}, "required": []string{"question"}})}}
}
func (m *Manager) Run(ctx context.Context, s api.Session, c api.Call, _ func(string)) api.ToolResult {
	var in struct {
		Kind       string   `json:"kind"`
		Question   string   `json:"question"`
		Options    []string `json:"options"`
		Credential string   `json:"credential"`
		WaitMS     int      `json:"wait_ms"`
		Defer      *bool    `json:"defer"`
	}
	result := api.ToolResult{Call: c.ID, Status: "failed"}
	if json.Unmarshal(c.Input, &in) != nil || in.Question == "" {
		result.Content = api.Text("invalid question input")
		return result
	}
	if in.Kind == "" {
		in.Kind = "text"
	}
	deferIt := true
	if in.Defer != nil {
		deferIt = *in.Defer
	}
	a, err := m.Ask(ctx, api.Question{Session: s.ID, Turn: api.Executing(ctx).Turn, Call: c.ID, Actor: c.Actor, Kind: in.Kind, Prompt: in.Question, Options: in.Options, Credential: in.Credential, Wait: time.Duration(in.WaitMS) * time.Millisecond, Defer: deferIt})
	switch {
	case errors.Is(err, api.ErrQuestionOpen):
		result.Status = "open"
	case err != nil:
		result.Content = api.Text(err.Error())
	case a.Declined:
		result.Status = "refused"
		result.Content = api.Text("User declined")
	default:
		result.Status = "completed"
		result.Content = api.Text(a.Value)
	}
	return result
}
