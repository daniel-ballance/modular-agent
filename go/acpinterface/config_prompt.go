package acpinterface

import (
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func selectOption(id, name, category, current string, values []string) acp.SessionConfigOption {
	options := acp.SessionConfigSelectOptionsUngrouped{}
	for _, v := range values {
		options = append(options, acp.SessionConfigSelectOption{Value: acp.SessionConfigValueId(v), Name: v})
	}
	return acp.SessionConfigOption{Select: &acp.SessionConfigOptionSelect{Id: acp.SessionConfigId(id), Name: name, Category: acp.Ptr(acp.SessionConfigOptionCategory(category)), Type: "select", CurrentValue: acp.SessionConfigValueId(current), Options: acp.SessionConfigSelectOptions{Ungrouped: &options}}}
}
func (s *server) config(id string) ([]acp.SessionConfigOption, error) {
	snap, err := s.a.Snapshot(id)
	if err != nil {
		return nil, err
	}
	var models, thinking []string
	// A saved selection is still the current value even when this build can't
	// use it. Only selectable models belong in the list of choices.
	currentModel := snap.Settings.Model
	for _, v := range s.a.All("provider.") {
		for _, m := range v.(api.Provider).Catalog() {
			models = append(models, modelValue(m))
			if modelMatches(m, snap.Settings.Model) {
				currentModel = modelValue(m)
				thinking = m.Thinking
			}
		}
	}
	approval := snap.Settings.Approval
	return []acp.SessionConfigOption{selectOption("model", "Model", "model", currentModel, models), selectOption("thinking", "Thinking", "thought_level", api.LowerReasoning(snap.Settings.Thinking, thinking), thinking), selectOption("approval", "Approval", "_approval", approvalValue(approval), []string{"off", "ask", "all", "never"})}, nil
}
func (s *server) SetSessionConfigOption(ctx context.Context, p acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	if p.ValueId == nil {
		return acp.SetSessionConfigOptionResponse{}, acp.NewInvalidParams(map[string]any{"reason": "only select options supported"})
	}
	v := p.ValueId
	id := string(v.SessionId)
	if host := s.sessionHost(id); host != s {
		return host.SetSessionConfigOption(ctx, p)
	}
	st, err := s.attached(id)
	if err != nil {
		return acp.SetSessionConfigOptionResponse{}, err
	}
	if !s.authorize(id, st.actor, "settings") {
		return acp.SetSessionConfigOptionResponse{}, acpError("forbidden")
	}
	opts, err := s.config(id)
	if err != nil {
		return acp.SetSessionConfigOptionResponse{}, err
	}
	valid := false
	for _, o := range opts {
		if o.Select.Id == v.ConfigId {
			for _, option := range *o.Select.Options.Ungrouped {
				if option.Value == v.Value {
					valid = true
				}
			}
		}
	}
	if !valid {
		return acp.SetSessionConfigOptionResponse{}, acp.NewInvalidParams(map[string]any{"reason": "unknown configuration option or value"})
	}
	snap, err := s.a.Snapshot(id)
	if err != nil {
		return acp.SetSessionConfigOptionResponse{}, err
	}
	switch string(v.ConfigId) {
	case "model":
		for _, p := range s.a.All("provider.") {
			for _, m := range p.(api.Provider).Catalog() {
				if modelValue(m) == string(v.Value) {
					snap.Settings.Model = modelValue(m)
					snap.Settings.Thinking = api.LowerReasoning(snap.Settings.Thinking, m.Thinking)
				}
			}
		}
	case "thinking":
		snap.Settings.Thinking = string(v.Value)
	case "approval":
		snap.Settings.Approval = api.ApprovalInternal(string(v.Value))
	}
	if err = s.a.SetSettings(s.acting(ctx, id, st.actor), id, snap.Settings); err != nil {
		return acp.SetSessionConfigOptionResponse{}, outputReplyError(err)
	}
	opts, err = s.config(id)
	return acp.SetSessionConfigOptionResponse{ConfigOptions: opts}, err
}
func promptContent(blocks []acp.ContentBlock) (api.Content, error) {
	var out api.Content
	for _, b := range blocks {
		switch {
		case b.Text != nil:
			out = append(out, api.Part{Type: "text", Text: b.Text.Text, Data: api.JSON(b)})
		case b.ResourceLink != nil:
			out = append(out, api.Part{Type: "text", Text: "Resource link: " + b.ResourceLink.Name + " (" + b.ResourceLink.Uri + ")", Data: api.JSON(b)})
		default:
			return nil, acp.NewInvalidParams(map[string]any{"reason": "unsupported prompt content type"})
		}
	}
	return out, nil
}
func (s *server) Prompt(ctx context.Context, p acp.PromptRequest) (acp.PromptResponse, error) {
	id := string(p.SessionId)
	if host := s.sessionHost(id); host != s {
		return host.Prompt(ctx, p)
	}
	st, err := s.attached(id)
	if err != nil {
		return acp.PromptResponse{}, err
	}
	content, err := promptContent(p.Prompt)
	if err != nil {
		return acp.PromptResponse{}, err
	}
	var meta struct {
		Key string `json:"key"`
	}
	if b := p.Meta[Namespace]; len(b) > 0 {
		if err = json.Unmarshal(b, &meta); err != nil {
			return acp.PromptResponse{}, acp.NewInvalidParams(nil)
		}
	}
	s.mu.Lock()
	if st.busy {
		s.mu.Unlock()
		return acp.PromptResponse{}, acp.NewInvalidRequest(map[string]any{"reason": "ACP v1 prompt already running; cancel or wait"})
	}
	st.busy = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); st.busy = false; s.mu.Unlock() }()
	// A previous turn from a release, extension input, or job may still be
	// finishing. Queue behind it instead of mixing the actors' input.
	if s.principal != nil && !s.authorize(id, st.actor, "input") {
		return acp.PromptResponse{}, acpError("forbidden")
	}
	receipt, err := s.a.Submit(s.acting(ctx, id, st.actor), id, api.Input{Key: meta.Key, When: "after", Content: content})
	if err != nil {
		return acp.PromptResponse{}, outputReplyError(err)
	}
	if receipt.Erased {
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn, Meta: map[string]json.RawMessage{Namespace: api.JSON(receiptValue(receipt))}}, nil
	}
	if receipt.Erased {
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn, Meta: map[string]json.RawMessage{Namespace: api.JSON(receiptValue(receipt))}}, nil
	}
	if receipt.Command != "" {
		_ = s.update(st.ctx, id, acp.UpdateAgentMessageText(receipt.Command))
	}
	out := api.Outcome{Status: "completed"}
	if receipt.When != "command" {
		if receipt.Duplicate {
			out = recordedOutcomeFor(s.a, id, receipt.ID, st.actor)
		}
		if !receipt.Duplicate || out.Status == "" {
			out, err = s.a.Wait(api.AsActor(ctx, st.actor), id)
			if err != nil && ctx.Err() != nil {
				select {
				case <-s.peer.Done():
					return acp.PromptResponse{}, ctx.Err()
				default:
				}
				if s.authorize(id, st.actor, "cancel") {
					_ = s.a.CancelAs(s.acting(context.Background(), id, st.actor), id)
				}
				out, err = s.a.Wait(api.AsActor(context.Background(), st.actor), id)
			}
			if err != nil {
				return acp.PromptResponse{}, outputReplyError(err)
			}
		}
		if original := recordedOutcomeFor(s.a, id, receipt.ID, st.actor); original.Status != "" {
			out = original
		} else if receipt.Duplicate {
			return acp.PromptResponse{}, acp.NewInvalidParams(map[string]string{"reason": "the original input was not taken by a turn"})
		}
	}
	response := promptResponse(receipt, out)
	if out.Status == "failed" && s.binding == Binding2 {
		return acp.PromptResponse{}, &acp.RequestError{Code: -32000, Message: out.Error, Data: map[string]any{"_meta": response.Meta}}
	}
	return response, nil
}
func recordedOutcome(a api.API, id, input string) api.Outcome {
	return recordedOutcomeFor(a, id, input, actor)
}
func recordedOutcomeFor(a api.API, id, input, who string) api.Outcome {
	snap, err := a.View(api.AsActor(context.Background(), who), id)
	if err != nil {
		return api.Outcome{}
	}
	accepted := map[string]api.Input{}
	for _, e := range snap.Entries {
		if e.Kind == "input.accepted" {
			in := api.Decode[api.Input](e.Data)
			accepted[in.ID] = in
		}
	}
	turn, active := "", ""
	var out api.Outcome
	for _, e := range snap.Entries {
		if e.Kind == "turn.start" {
			if out.Status != "" {
				break
			}
			active = e.Turn
			if api.Decode[api.TurnStart](e.Data).Input == input {
				turn = e.Turn
			}
		}
		if e.Kind == "input" && e.InputID() == input {
			turn = e.Turn
			if turn == "" {
				turn = active
			}
		}
		if turn != "" && e.Kind == "turn.end" && e.Turn == turn {
			out = api.Decode[api.Outcome](e.Data)
		}
		if e.Kind == "turn.end" {
			active = ""
		}
		if out.Status == "cancelled" && e.Kind == "input.returned" {
			for _, id := range e.HandedBackIDs() {
				if in, ok := accepted[id]; ok {
					out.Returned = append(out.Returned, in)
				}
			}
		}
	}
	return out
}
