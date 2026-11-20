package acpinterface

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"os"
	"slices"
	"strings"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func uniquePairs(pairs []api.EntryPair) []api.EntryPair {
	out := []api.EntryPair{}
	seen := map[api.EntryPair]bool{}
	for _, pair := range pairs {
		if !seen[pair] {
			seen[pair] = true
			out = append(out, pair)
		}
	}
	return out
}

func (s *server) HandleExtensionMethod(ctx context.Context, method string, b json.RawMessage) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(b, &p)
	if host := s.sessionHost(p.SessionID); host != s {
		return host.HandleExtensionMethod(ctx, method, b)
	}
	result, err := s.handleExtensionMethod(ctx, method, b)
	if err == nil {
		if st, e := s.attached(p.SessionID); e == nil {
			if method != "_modular-agent/requests" {
				result, err = s.gateAnswer(api.AsActor(ctx, st.actor), p.SessionID, method, result)
			}
		}
	}
	return result, outputReplyError(err)
}

func (s *server) handleExtensionMethod(ctx context.Context, method string, b json.RawMessage) (any, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	var p struct {
		SessionID string          `json:"sessionId"`
		Rights    json.RawMessage `json:"rights"`
		Present   *bool           `json:"present"`
		ActorID   string          `json:"actorId"`
		Actor     json.RawMessage `json:"actor"`
		After     string          `json:"after"`
		All       bool            `json:"all"`
		Content   json.RawMessage `json:"content"`
		When      string          `json:"when"`
		Key       string          `json:"key"`
		RequestID string          `json:"requestId"`
		Value     json.RawMessage `json:"value"`
		Declined  bool            `json:"declined"`
		EntryID   string          `json:"entryId"`
		Rewind    bool            `json:"rewind"`
		EntryIDs  []string        `json:"entryIds"`
		JobID     string          `json:"jobId"`
		Command   string          `json:"command"`
		InputID   string          `json:"inputId"`
		Call      api.Call        `json:"call"`
	}
	if err := json.Unmarshal(b, &p); err != nil || p.SessionID == "" {
		return nil, acpError("invalid_params")
	}
	st, err := s.attached(p.SessionID)
	if err != nil {
		return nil, err
	}
	// Proposals, release and withdraw also serve parked job reports.
	feature := ""
	represented := p.ActorID != "" && p.ActorID != st.actor
	switch method {
	case "_modular-agent/actors", "_modular-agent/join", "_modular-agent/leave":
		feature = "severalActors"
	case "_modular-agent/input":
		if p.When == "propose" || represented {
			feature = "severalActors"
		}
	case "_modular-agent/requests", "_modular-agent/answer":
		if represented {
			feature = "severalActors"
		}
	case "_modular-agent/limit":
		feature = "sessionLimits"
	case "_modular-agent/tenant":
		feature = "tenants"
	}
	if feature != "" && s.declaration(p.SessionID)[feature] != true {
		return nil, acpError("not_supported")
	}
	ctx = api.AsActor(ctx, st.actor)
	switch method {
	case "_modular-agent/input":
		if !validTiming(p.When) && p.When != "propose" {
			return nil, acp.NewInvalidParams(map[string]any{"reason": "invalid intake timing"})
		}
		var content api.Content
		var str string
		if json.Unmarshal(p.Content, &str) == nil {
			content = api.Text(str)
		} else {
			var blocks []acp.ContentBlock
			if err = json.Unmarshal(p.Content, &blocks); err != nil {
				return nil, acp.NewInvalidParams(nil)
			}
			content, err = promptContent(blocks)
			if err != nil {
				return nil, err
			}
		}
		in := api.Input{Key: p.Key, When: p.When, Content: content, Actor: st.actor}
		if p.ActorID != "" && p.ActorID != st.actor {
			if !s.represents[p.ActorID] {
				return nil, acpError("forbidden")
			}
			in.Actor, in.ViaActor = p.ActorID, st.actor
		}
		receipt, err := s.a.Submit(ctx, p.SessionID, in)
		if err != nil {
			return nil, invalidActorRequest(err)
		}
		if receipt.Duplicate && !receipt.Erased && receipt.When == "" {
			return nil, acpError("conflict")
		}
		return receiptValue(receipt), nil
	case "_modular-agent/actors":
		return s.actors(ctx, p.SessionID, st.actor)
	case "_modular-agent/join":
		var joined api.Actor
		if err := json.Unmarshal(p.Actor, &joined); err != nil {
			return nil, acp.NewInvalidParams(nil)
		}
		return s.join(ctx, p.SessionID, joined, p.Present == nil || *p.Present)
	case "_modular-agent/leave":
		if err := s.a.(actorSessions).LeaveActor(ctx, p.SessionID, p.ActorID); err != nil {
			return nil, invalidActorRequest(err)
		}
		s.setPresence(p.SessionID, p.ActorID, false)
		return map[string]any{}, nil
	case "_modular-agent/release":
		if !p.Declined && !validTiming(p.When) {
			return nil, acp.NewInvalidParams(nil)
		}
		receipt, err := s.a.(actorSessions).ReleaseInput(ctx, p.SessionID, p.InputID, p.When, p.Declined)
		if err != nil {
			return nil, invalidActorRequest(err)
		}
		return receiptValue(receipt), nil
	case "_modular-agent/history":
		snap, err := s.historyView(ctx, p.SessionID)
		if err != nil {
			return nil, err
		}
		entries := snap.Branch()
		if p.All {
			entries = snap.Entries
		}
		start := 0
		if p.After != "" {
			found := false
			for i, e := range entries {
				if e.ID == p.After {
					start = i + 1
					found = true
					break
				}
			}
			if !found {
				return nil, acp.NewInvalidParams(map[string]any{"reason": "unknown history cursor"})
			}
		}
		out := []map[string]any{}
		for _, e := range entries[start:] {
			out = append(out, entryValue(e))
		}
		return map[string]any{"entries": out}, nil
	case "_modular-agent/requests":
		who := st.actor
		if p.ActorID != "" {
			if p.ActorID != who && !s.represents[p.ActorID] {
				return nil, acpError("forbidden")
			}
			who = p.ActorID
		}
		return s.projectRequests(ctx, st, p.SessionID, who, true)
	case "_modular-agent/answer":
		if p.RequestID == "" {
			return nil, acpError("invalid_params")
		}
		if p.ActorID != "" && p.ActorID != st.actor && !s.represents[p.ActorID] {
			return nil, acpError("forbidden")
		}
		if !s.a.Authorize(p.SessionID, st.actor, "answer") && !s.a.Authorize(p.SessionID, st.actor, "approve") {
			return nil, acpError("forbidden")
		}
		who := p.ActorID
		if who == "" {
			who = st.actor
		}
		for _, q := range s.openQuestions(p.SessionID) {
			if q.ID == p.RequestID && q.Kind == "approval" {
				s.mu.Lock()
				exact := st.polled[questionRecipient{q.ID, who}] || st.requests[questionRecipient{q.ID, who}] != nil
				s.mu.Unlock()
				if !exact {
					return map[string]any{"accepted": false, "reason": "not_open"}, nil
				}
			}
		}
		value := ""
		if len(p.Value) > 0 && string(p.Value) != "null" {
			if err = json.Unmarshal(p.Value, &value); err != nil {
				return map[string]any{"accepted": false, "reason": "answer must be a string"}, nil
			}
		}
		err = s.answerFor(ctx, p.SessionID, p.ActorID, api.Answer{Request: p.RequestID, Value: value, Declined: p.Declined || len(p.Value) == 0 || string(p.Value) == "null"})
		if errors.Is(err, api.ErrInvalidAnswer) {
			return nil, acpError("invalid_params")
		}
		if err != nil {
			return map[string]any{"accepted": false, "reason": "not_open"}, nil
		}
		return map[string]any{"accepted": true}, nil
	case "_modular-agent/fork":
		if p.EntryID == "" {
			return nil, acp.NewInvalidParams(nil)
		}
		s.lifecycle.Lock()
		defer s.lifecycle.Unlock()
		id, err := s.a.Fork(ctx, p.SessionID, p.EntryID)
		if errors.Is(err, api.ErrResultTooLarge) {
			return nil, acpError("result_too_large")
		}
		if err != nil {
			return nil, err
		}
		s.attach(id, false, st.actor)
		return map[string]string{"sessionId": id}, nil
	case "_modular-agent/move":
		if p.EntryID == "" {
			return nil, acp.NewInvalidParams(nil)
		}
		outside, err := s.a.(interface {
			MoveDetails(context.Context, string, string, bool) ([]string, error)
		}).MoveDetails(ctx, p.SessionID, p.EntryID, p.Rewind)
		if errors.Is(err, api.ErrMoveConflict) {
			return nil, acpError("conflict")
		}
		if err != nil {
			return nil, invalidActorRequest(err)
		}
		if len(outside) != 0 {
			return map[string]any{"outOfReach": outside}, nil
		}
		return map[string]any{}, nil
	case "_modular-agent/erase":
		if !s.a.Authorize(p.SessionID, st.actor, "erase") {
			return nil, acpError("forbidden")
		}
		source, err := s.a.Snapshot(p.SessionID)
		if err != nil {
			return nil, err
		}
		for _, id := range p.EntryIDs {
			if !slices.ContainsFunc(source.Entries, func(e api.Entry) bool { return e.ID == id }) {
				return nil, acpError("not_found")
			}
		}
		report := api.ProviderErasure{Pending: []string{}, OutOfReach: []string{}}
		if eraser, ok := s.a.(interface {
			EraseDetails(context.Context, string, []string) (api.ProviderErasure, error)
		}); ok {
			report, err = eraser.EraseDetails(ctx, p.SessionID, p.EntryIDs)
		} else {
			err = s.a.Erase(ctx, p.SessionID, p.EntryIDs)
		}
		if errors.Is(err, os.ErrNotExist) {
			return nil, acpError("not_found")
		}
		if errors.Is(err, api.ErrEraseForbidden) {
			return nil, acpError("forbidden")
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"erased": uniquePairs(report.ErasedPairs), "pending": uniquePairs(report.PendingPairs), "outOfReach": append([]string{"output already delivered", "working-environment effects"}, report.OutOfReach...)}, nil
	case "_modular-agent/jobs":
		if !s.a.Authorize(p.SessionID, st.actor, "watch") {
			return nil, acpError("forbidden")
		}
		v, err := s.a.Get("jobs")
		if err != nil {
			return nil, err
		}
		jobs, err := v.(interface {
			Active(string) ([]api.Job, error)
		}).Active(p.SessionID)
		if err != nil {
			return nil, err
		}
		out := []map[string]string{}
		for _, job := range jobs {
			out = append(out, map[string]string{"id": job.ID, "kind": job.Kind, "state": job.State})
		}
		return map[string]any{"jobs": out}, nil
	case "_modular-agent/cancel-job":
		v, err := s.a.Get("jobs")
		if err != nil {
			return nil, err
		}
		if !s.a.Authorize(p.SessionID, st.actor, "cancel") {
			return nil, acpError("forbidden")
		}
		err = v.(api.Jobs).Cancel(ctx, p.SessionID, p.JobID)
		switch {
		case errors.Is(err, api.ErrJobNotFound):
			return nil, acpError("not_found")
		case errors.Is(err, api.ErrJobCommitLost), errors.Is(err, api.ErrJobCleanupLost):
			return nil, acpError("lost")
		}
		return map[string]any{}, err
	case "_modular-agent/support":
		return s.declaration(p.SessionID), nil
	case "_modular-agent/command":
		if strings.TrimSpace(p.Command) == "" {
			return nil, acp.NewInvalidParams(nil)
		}
		result, err := s.a.Command(ctx, p.SessionID, p.Command)
		if opts, e := s.config(p.SessionID); e == nil {
			_ = s.update(st.ctx, p.SessionID, acp.SessionUpdate{ConfigOptionUpdate: &acp.SessionConfigOptionUpdate{SessionUpdate: "config_option_update", ConfigOptions: opts}})
		}
		return result, err
	case "_modular-agent/limit":
		var rights []string
		if json.Unmarshal(p.Rights, &rights) != nil {
			return nil, acp.NewInvalidParams(nil)
		}
		err := s.a.(interface {
			Limit(context.Context, string, []string) error
		}).Limit(ctx, p.SessionID, rights)
		if err != nil {
			return nil, invalidActorRequest(err)
		}
		return map[string]any{}, nil
	case "_modular-agent/tenant":
		out, err := s.a.(interface {
			Tenant(context.Context, string) (map[string]any, error)
		}).Tenant(ctx, p.SessionID)
		if err != nil {
			return nil, invalidActorRequest(err)
		}
		return out, nil
	case "_modular-agent/proposals":
		return s.proposals(ctx, p.SessionID)
	case "_modular-agent/withdraw":
		err := s.a.(interface {
			WithdrawProposal(context.Context, string, string, string) error
		}).WithdrawProposal(ctx, p.SessionID, p.InputID, p.ActorID)
		if err != nil {
			return nil, invalidActorRequest(err)
		}
		return map[string]any{}, nil
	case "_modular-agent/call_tool":
		return s.a.CallTool(ctx, p.SessionID, api.Call{Name: p.Call.Name, Input: p.Call.Input})
	default:
		return nil, acp.NewMethodNotFound(method)
	}
}
