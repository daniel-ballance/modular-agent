package modular

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type MoveOptions struct{ Rewind bool }

// MoveTo selects an earlier position, optionally restoring an environment point.
func (s *Session) MoveTo(ctx context.Context, entryID string, options ...MoveOptions) error {
	if entryID == "" || len(options) > 1 {
		return &Error{Code: InvalidParams, Message: "expected an entry ID and at most one MoveOptions"}
	}
	if err := s.require(ctx, "settings"); err != nil {
		return err
	}
	rewind := len(options) == 1 && options[0].Rewind
	if rewind && s.agent.Declaration()["rewinding"] != true {
		return &Error{Code: NotSupported, Message: "working environment does not support rewind"}
	}
	err := s.agent.a.Move(s.ctx(ctx), s.id, entryID, rewind)
	if errors.Is(err, api.ErrMoveConflict) {
		return appError(err, Conflict)
	}
	if err == nil {
		s.emitOperation(ctx, "position.moved", map[string]any{"entryId": entryID, "rewind": rewind})
	}
	return appError(err, Busy)
}

type EntryPair = api.EntryPair
type ErasureReport struct {
	Erased     []EntryPair `json:"erased"`
	Pending    []EntryPair `json:"pending"`
	OutOfReach []string    `json:"outOfReach"`
}

// Erase removes controlled copies of entries, and reports copies out of reach.
func (s *Session) Erase(ctx context.Context, entries []string) (ErasureReport, error) {
	if !s.agent.erasure {
		return ErasureReport{}, &Error{Code: NotSupported, Message: "history does not support erasure"}
	}
	if len(entries) == 0 {
		return ErasureReport{}, &Error{Code: InvalidParams, Message: "at least one entry ID is required"}
	}
	if err := s.require(ctx, "erase"); err != nil {
		return ErasureReport{}, err
	}
	a := s.agent.a.(interface {
		EraseDetails(context.Context, string, []string) (api.ProviderErasure, error)
	})
	result, err := a.EraseDetails(s.ctx(ctx), s.id, entries)
	if errors.Is(err, api.ErrEraseForbidden) {
		return ErasureReport{}, appError(err, Forbidden)
	}
	report := ErasureReport{Erased: append([]EntryPair{}, result.ErasedPairs...), Pending: append([]EntryPair{}, result.PendingPairs...), OutOfReach: append([]string{"output already delivered", "working-environment effects"}, result.OutOfReach...)}
	if err == nil {
		s.emitOperation(ctx, "entries.erased", report)
	}
	return report, appError(err, Busy)
}

// CallTool runs a tool directly as this actor, with the same gates as model calls.
func (s *Session) CallTool(ctx context.Context, name string, input any) (ToolResult, error) {
	if name == "" {
		return ToolResult{}, &Error{Code: InvalidParams, Message: "tool name is required"}
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return ToolResult{}, appError(err, NotOpen)
	}
	if err := s.require(ctx, "tools"); err != nil {
		return ToolResult{}, err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ToolResult{}, appError(err, InvalidParams)
	}
	result, err := s.agent.a.CallTool(s.ctx(ctx), s.id, api.Call{Name: name, Input: raw})
	out := ToolResult{Name: name}
	if decodeErr := decodeInto(portable.Result(result), &out); decodeErr != nil && err == nil {
		err = decodeErr
	}
	return out, appError(err, Busy)
}

// Proposals lists parked input through the actor's gated history view.
func (s *Session) Proposals(ctx context.Context) ([]HistoryEntry, error) {
	a := s.agent.a.(interface {
		Proposals(context.Context, string) ([]api.Entry, error)
	})
	entries, err := a.Proposals(s.ctx(ctx), s.id)
	if err != nil {
		return nil, appError(err, Forbidden)
	}
	view, err := s.view(ctx)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, e := range entries {
		ids[e.ID] = true
	}
	out := []HistoryEntry{}
	for _, e := range view.Entries {
		if ids[e.ID] {
			out = append(out, HistoryEntry(portable.Entry(e)))
		}
	}
	return out, nil
}

// Release admits a pending proposal with the given timing, or hands it back.
func (s *Session) Release(ctx context.Context, id string, timing Timing, decline ...bool) (InputReceipt, error) {
	declined := len(decline) == 1 && decline[0]
	if id == "" || len(decline) > 1 || !declined && timing != Now && timing != After && timing != Steer {
		return InputReceipt{}, &Error{Code: InvalidParams, Message: "invalid proposal release"}
	}
	a := s.agent.a.(interface {
		ReleaseInput(context.Context, string, string, string, bool) (api.Receipt, error)
	})
	r, err := a.ReleaseInput(s.ctx(ctx), s.id, id, string(timing), declined)
	receipt := InputReceipt{InputID: r.ID, Disposition: r.When}
	if err == nil {
		if declined {
			s.emitOperation(ctx, "input.returned", []string{id})
		} else {
			s.emitOperation(ctx, "input.accepted", receipt)
		}
	}
	return receipt, appError(err, Conflict)
}

// Withdraw removes a pending proposal without running it.
func (s *Session) Withdraw(ctx context.Context, id string) error {
	if id == "" {
		return &Error{Code: InvalidParams, Message: "proposal ID is required"}
	}
	a := s.agent.a.(interface {
		WithdrawProposal(context.Context, string, string, string) error
	})
	err := a.WithdrawProposal(s.ctx(ctx), s.id, id, "")
	if err == nil {
		s.emitOperation(ctx, "input.withdrawn", map[string]any{"inputId": id})
	}
	return appError(err, Conflict)
}

func (s *Session) emitOperation(ctx context.Context, kind string, data any) {
	s.agent.a.Emit(s.ctx(ctx), api.Event{Kind: kind, Session: s.id, Actor: s.actorID(), Data: api.JSON(data)})
}
