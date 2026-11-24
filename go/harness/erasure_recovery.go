package harness

import (
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// settleForErasure closes work without passing an affected snapshot to a
// Runtime or job owner. It runs only after taking the writer lease. Records
// describe what is known, not that a dispatched effect was stopped.
func settleForErasure(row api.Session) api.Session {
	next := row
	next.Entries = slices.Clip(row.Entries)
	settledTurns, settledSteps := map[string]bool{}, map[string]bool{}
	endedJobs, closedQuestions := map[string]bool{}, map[string]bool{}
	startedCalls := map[string]bool{}
	type workRef struct{ turn, step, actor string }
	refs := map[string]workRef{}
	usage := map[string]api.Usage{}
	for _, e := range row.LiveEntries() {
		switch {
		case e.WasKind("turn.end"):
			settledTurns[e.Turn] = true
		case e.WasKind("model"):
			settledSteps[e.Step] = true
			used := api.Decode[struct{ Usage api.Usage }](e.Data).Usage
			u := usage[e.Turn]
			u.Add(used)
			usage[e.Turn] = u
		case e.WasKind("job.end"):
			endedJobs[e.Job] = true
		case e.WasKind("tool.started"):
			startedCalls[e.Call] = true
			refs[e.Call] = workRef{e.Turn, e.Step, e.Actor}
		case e.Kind == "tool.call":
			refs[e.Call] = workRef{e.Turn, e.Step, e.Actor}
		case e.Kind == "question.answer":
			closedQuestions[api.Decode[api.Answer](e.Data).Request] = true
		case e.Kind == "question.secret":
			closedQuestions[api.Decode[string](e.Data)] = true
		}
	}
	add := func(e api.Entry) { appendEntry(&next, e, "harness", true) }
	const reason = "Interrupted by pending erasure."
	for _, e := range row.LiveEntries() {
		switch {
		case e.Kind == "model.request" && !settledSteps[e.Step]:
			// No acknowledgement proves a response. Keep the attempt,
			// but never give it to a Runtime for replay.
			add(api.Entry{Kind: "model", Turn: e.Turn, Step: e.Step, Actor: e.Actor, Data: api.JSON(map[string]any{
				"stop": "failed", "wire": map[string]any{"error": map[string]string{"kind": "other", "message": reason}},
			})})
			settledSteps[e.Step] = true
		case e.Kind == "question.open":
			q := api.Decode[struct{ Question api.Question }](e.Data).Question
			if q.ID != "" && !closedQuestions[q.ID] {
				add(api.Entry{Kind: "question.answer", Turn: e.Turn, Step: e.Step, Call: e.Call, Actor: e.Actor,
					Copies: []string{e.ID}, Data: api.JSON(api.Answer{Request: q.ID, Declined: true, Reason: "noLongerAnswerable"})})
				closedQuestions[q.ID] = true
			}
		case e.Kind == "job.start" && !endedJobs[e.Job]:
			job := api.Decode[api.Job](e.Data)
			job.State, job.Outcome = "ended", api.Outcome{Status: "unknown"}
			job.Detail, job.Report, job.ResultPresent, job.CleanupUnconfirmed = nil, false, false, true
			add(api.Entry{Kind: "job.end", Job: e.Job, Turn: e.Turn, Call: e.Call, Actor: e.Actor, Writer: e.Writer, Data: api.JSON(job)})
			add(api.Entry{Kind: "job.cleanup", Job: e.Job})
			endedJobs[e.Job] = true
		}
		if e.Kind == "model" {
			for _, part := range e.Content {
				if part.Call != nil {
					if _, exists := refs[part.Call.ID]; !exists {
						refs[part.Call.ID] = workRef{e.Turn, e.Step, e.Actor}
					}
				}
			}
		}
	}
	waits := api.WaitingApprovals(next)
	live := row
	live.Entries = row.LiveEntries()
	handoffs := api.InterfaceHandoffs(row)
	for _, call := range api.OpenCalls(live) {
		status := "not_started"
		if startedCalls[call.ID] {
			status = "unknown"
		}
		ref := refs[call.ID]
		r := api.ToolResult{Call: call.ID, Name: call.Name, Status: status, Content: api.Text(reason)}
		e := api.Entry{Kind: "tool.result", Turn: ref.turn, Step: ref.step, Call: call.ID, Actor: ref.actor, Data: api.JSON(r), Content: r.Content}
		if cp := handoffs[call.ID]; cp.ID != "" {
			e.Turn, e.Step = cp.Turn, cp.Step
			e.Copies = []string{cp.Parent, cp.ID}
			add(e)
			next.Entries[len(next.Entries)-1].Actor = ""
		} else {
			if w := waits[call.ID]; w != nil {
				e.Copies = []string{w.Request.ID}
				if w.Decision.ID != "" {
					e.Copies = append(e.Copies, w.Decision.ID)
				}
			}
			add(e)
		}
	}
	for _, e := range row.LiveEntries() {
		if e.Kind == "turn.start" && !settledTurns[e.Turn] {
			add(api.Entry{Kind: "turn.end", Turn: e.Turn, Actor: e.Actor, Data: api.JSON(api.Outcome{Status: "failed", Error: reason, Usage: usage[e.Turn]})})
			settledTurns[e.Turn] = true
		}
	}
	return next
}
