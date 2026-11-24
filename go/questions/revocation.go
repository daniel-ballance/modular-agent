package questions

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
)

// RevokedQuestions is called under the session writer lock. A grant change
// closes a wait only if it took away the last eligible route. Presence loss
// alone never reaches this path. Waiting approvals have their own settlement.
func (m *Manager) RevokedQuestions(before, after api.Session, allowed func(api.Session, string, string) bool) []api.Entry {
	if before.Parent != "" {
		return nil
	}
	m.routesMu.RLock()
	defer m.routesMu.RUnlock()
	eligible := func(s api.Session, q api.Question) bool {
		ok := func(actor string) bool {
			if len(q.Allowed) > 0 && !slices.Contains(q.Allowed, actor) {
				return false
			}
			if q.Kind == "approval" {
				return m.hasRoute(q, actor) && allowed(s, actor, "approve") && allowed(s, actor, "watch")
			}
			return allowed(s, actor, "answer")
		}
		if s.Actors == nil {
			return ok(s.Actor)
		}
		for actor := range s.Actors {
			if ok(actor) {
				return true
			}
		}
		return false
	}
	var closures []api.Entry
	for _, s := range states(before) {
		q := s.q.Question
		if s.answer != nil || s.selected != "" || s.closed || q.ApprovalWait != "" || !eligible(before, q) || eligible(after, q) {
			continue
		}
		a := api.Answer{Request: q.ID, Declined: true, Reason: "noLongerAnswerable", Cause: "revoked"}
		if q.Kind == "approval" {
			a.Reason = "refused"
		}
		if expired(q) {
			a.Reason, a.Cause = "timeLimit", ""
		}
		closures = append(closures, api.Entry{Kind: "question.answer", Turn: q.Turn, Step: q.Step, Call: q.Call, OperatorAdmission: true, Copies: []string{q.ID}, Data: api.JSON(a)})
	}
	return closures
}
