package api

import (
	"context"
	"errors"
	"slices"
	"time"
)

const UntilDeadline = "untilDeadline"

var ErrApprovalExpired = errors.New("approval deadline reached")

func GateFailureStatus(err error) string {
	if errors.Is(err, ErrApprovalExpired) {
		return "not_started"
	}
	return "refused"
}

// ApprovalView attests to an unchanged delivery. It is private history, not a tool allowance.
type ApprovalView struct {
	RequestEntryID string   `json:"requestEntryId"`
	SubmittedBy    string   `json:"submittedBy"`
	RouteID        string   `json:"routeId"`
	Rights         []string `json:"rights"`
}

// Route checks are installed by the operator's binding. They must work after
// reconnect and may not treat a saved route ID as evidence of presence.
type ApprovalRouteCheck func(context.Context, Question, string) bool

type WaitingApprovalHost interface {
	PresentApproval(context.Context, Question, string, string) bool
	ForgetApprovalRoute(session, instance string)
	AnswerWaiting(context.Context, string, string, Answer) error
}

type WaitingApproval struct {
	Request, Pending, Decision, Start, Terminal, End Entry
	Question                                         Question
	Answer                                           Answer
	Listed                                           bool
}

// WaitingApprovals folds only the current branch's original requests. Starts
// and terminal identities bar another handoff even across a position change.
func WaitingApprovals(s Session) map[string]*WaitingApproval {
	live := s.LiveEntries()
	s.Entries = live
	branch := s.Branch()
	var out map[string]*WaitingApproval
	for _, e := range branch {
		if e.Kind != "question.open" {
			continue
		}
		q := Decode[struct{ Question Question }](e.Data).Question
		if q.ApprovalWait == "" {
			continue
		}
		if out == nil {
			out = map[string]*WaitingApproval{}
		}
		if q.Deadline == nil {
			t := time.UnixMilli(e.Time.UnixMilli() + q.Wait.Milliseconds()).UTC()
			q.Deadline = &t
		}
		out[e.Call] = &WaitingApproval{Request: e, Question: q}
	}
	if len(out) == 0 {
		return nil
	}
	for _, e := range branch {
		if e.Kind == "turn.end" {
			o := Decode[Outcome](e.Data)
			for id, w := range out {
				if e.Turn == w.Request.Turn {
					w.End = e
					w.Listed = o.Status == "completed" && slices.ContainsFunc(o.Open, func(c Call) bool { return c.ID == id })
				}
			}
		}
		w := out[e.Call]
		if w == nil {
			continue
		}
		switch e.Kind {
		case "tool.open":
			if e.Turn == w.Request.Turn && e.Step == w.Request.Step {
				d := Decode[struct {
					RequestIDs    []string
					ToolStartedID string
				}](e.Data)
				if slices.Equal(d.RequestIDs, []string{w.Question.ID}) && d.ToolStartedID == "" {
					w.Pending = e
				}
			}
		case "question.answer":
			a := Decode[Answer](e.Data)
			if a.Request == w.Question.ID && e.Turn == w.Request.Turn && e.Step == w.Request.Step && slices.Contains(e.Copies, w.Request.ID) {
				w.Decision, w.Answer = e, a
			}
		}
	}
	for _, e := range live {
		if w := out[e.Call]; w != nil {
			if e.WasKind("tool.result") {
				w.Terminal = e
			}
			if e.WasKind("tool.started") {
				w.Start = e
			}
		}
	}
	return out
}
