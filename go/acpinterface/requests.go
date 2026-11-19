package acpinterface

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
	"slices"
)

func (s *server) openQuestions(id string) []api.Question {
	questions, _ := s.questions().List(id)
	return slices.DeleteFunc(questions, func(q api.Question) bool { return !q.Answerable })
}

func (s *server) approvalCall(q api.Question) api.Call {
	if q.ApprovalCall != nil {
		return *q.ApprovalCall
	}
	snap, _ := s.a.Snapshot(q.Session)
	for _, e := range snap.Entries {
		if e.Kind == "tool.call" && e.Call == q.Call {
			return api.Decode[api.Call](e.Data)
		}
		for _, p := range e.Content {
			if p.Call != nil && p.Call.ID == q.Call {
				return *p.Call
			}
		}
	}
	return api.Call{}
}

func (s *server) eligible(st *attachment, q api.Question, who string) bool {
	right := "answer"
	if q.Kind == "approval" {
		right = "approve"
	}
	s.mu.Lock()
	present := who == st.actor || st.joined[who] != nil
	s.mu.Unlock()
	return q.Answerable && present && (q.Allowed == nil || slices.Contains(q.Allowed, who)) &&
		s.a.Authorize(q.Session, who, right) && s.a.Authorize(q.Session, st.actor, right)
}

func (s *server) projectRequests(ctx context.Context, st *attachment, id, who string, remember bool) (map[string]any, error) {
	if !s.a.Authorize(id, who, "watch") || !s.a.Authorize(id, st.actor, "watch") {
		return nil, acpError("forbidden")
	}
	out := []map[string]any{}
	original := map[string][]byte{}
	for _, q := range s.openQuestions(id) {
		view := requestValue(q)
		if q.Kind == "approval" {
			call := s.approvalCall(q)
			if call.ID == "" {
				continue
			}
			view["call"] = map[string]any{"name": call.Name, "input": call.Input}
		}
		out = append(out, view)
		original[q.ID] = api.JSON(view)
	}
	gated, err := s.gateAnswer(api.AsActor(ctx, who), id, "_modular-agent/requests", map[string]any{"requests": out})
	if err != nil {
		return nil, err
	}
	result := api.Decode[struct{ Requests []map[string]any }](api.JSON(gated))
	if result.Requests == nil || len(result.Requests) != len(out) {
		return nil, api.ErrOutputWithheld
	}
	live := map[string]api.Question{}
	for _, q := range s.openQuestions(id) {
		live[q.ID] = q
	}
	for i, view := range result.Requests {
		ref, _ := view["id"].(string)
		if ref != out[i]["id"] || view["kind"] != out[i]["kind"] {
			return nil, api.ErrOutputWithheld
		}
		delete(view, "answerable")
		q := live[ref]
		answerable := q.ID != "" && s.eligible(st, q, who)
		if view["kind"] == "approval" {
			answerable = answerable && portable.EqualJSON(original[ref], api.JSON(view))
			if remember {
				s.mu.Lock()
				st.polled[questionRecipient{ref, who}] = answerable
				s.mu.Unlock()
			}
		}
		view["answerable"] = answerable
	}
	return map[string]any{"requests": result.Requests}, nil
}
