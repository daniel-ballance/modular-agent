package harness

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sort"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
)

const interfaceCopyNotice = "A copy may remain with the Interface executor."

func unfinishedBesidesInterfaces(s api.Session) bool {
	if hasUnfinishedJobs(s) {
		return true
	}
	handoffs := api.InterfaceHandoffs(s)
	waits := api.WaitingApprovals(s)
	for _, call := range api.OpenCalls(s) {
		if handoffs[call.ID].ID == "" && waits[call.ID] == nil {
			return true
		}
	}
	return false
}

func affectedInterfaceCopy(s api.Session, id string) bool {
	for _, e := range s.LiveEntries() {
		if e.ID != id {
			continue
		}
		if e.WasKind(api.InterfaceHandoffKind) {
			return true
		}
		if e.WasKind("tool.result") && api.InterfaceHandoffs(s)[e.Call].ID != "" {
			return true
		}
	}
	return false
}

const (
	InterfaceAccepted       = "accepted"
	InterfaceAlreadySettled = "alreadySettled"
	InterfaceRefused        = "refused"
	InterfaceNotReady       = "notReady"
)

func (i *InterfaceConnection) ReportToolResult(ctx context.Context, report api.InterfaceReport) (string, error) {
	if report.CallID == "" || (report.Status != "completed" && report.Status != "failed") || report.Content == nil || (len(report.Value) != 0 && !json.Valid(report.Value)) {
		return InterfaceRefused, nil
	}
	for _, part := range report.Content {
		if part.Type == "" || part.Type == "toolCall" || part.Call != nil || (len(part.Data) != 0 && !json.Valid(part.Data)) || (len(part.Wire) != 0 && !json.Valid(part.Wire)) {
			return InterfaceRefused, nil
		}
	}
	if encoded := api.JSON(report); len(encoded) == 0 || len(encoded) > 1<<20 {
		return InterfaceRefused, nil
	}
	s := i.s
	s.interfaceReports.Lock()
	defer s.interfaceReports.Unlock()
	s.mu.Lock()
	cp, call, state, err := i.checkReportLocked(ctx, report.CallID)
	if state != "" || err != nil {
		s.mu.Unlock()
		return state, err
	}
	var admission api.Input
	for _, e := range s.data.Branch() {
		if e.Turn == cp.Turn && e.Kind == "turn.start" {
			admission = turnAdmission(s.data, e)
			break
		}
	}
	s.mu.Unlock()
	ctx, operation := telemetry.Start(telemetry.Session(ctx, s.id), "modular_agent.tool.report")
	defer operation.End()
	i.c.h.mu.RLock()
	owner := i.c.h.caps["runtime"].owner
	i.c.h.mu.RUnlock()
	p := &turnPorts{c: &client{h: i.c.h, owner: owner}, s: s, id: cp.Turn, actor: call.Actor, input: admission}
	result := api.ToolResult{Call: call.ID, Name: call.Name, Reference: call.Reference, Status: report.Status, Content: clone(report.Content), Structured: slices.Clone(report.Value)}
	if result.Status == "failed" && len(result.Content) == 0 {
		result.Content = api.Text("The Interface reported failure.")
	}
	for _, def := range i.c.h.interfaceTools[call.Name].Definitions {
		if def.Name == call.Name {
			result.Returns = def.Output
			break
		}
	}
	func() {
		defer func() {
			if recover() != nil {
				result.Content, result.Structured = api.Text("Tool result processing failed."), nil
				result.ProcessingError = errors.New("tool.after panicked")
			}
		}()
		checked, hookErr := p.Hook(api.WithConnectionRights(ctx, admission.ConnectionRights), "runtime.tool.after", api.AfterTool{Call: call, Result: result})
		if hookErr != nil {
			result.Content, result.Structured, result.ProcessingError = api.Text("Tool result processing failed."), nil, hookErr
			return
		}
		result = checked.(api.AfterTool).Result
	}()
	s.mu.Lock()
	cp, _, state, err = i.checkReportLocked(ctx, report.CallID)
	if state != "" || err != nil {
		s.mu.Unlock()
		return state, err
	}
	entry, err := i.c.h.appendInterfaceResultLocked(s, cp, result, i.actor, ctx)
	if err == nil {
		if s.interfaceParents == nil {
			s.interfaceParents = map[string]*telemetry.Wire{}
		}
		s.interfaceParents[cp.Turn] = telemetry.WorkWire(ctx)
		i.c.h.armInterfaceTimerLocked(s)
	}
	s.mu.Unlock()
	if err != nil {
		return InterfaceRefused, err
	}
	i.c.Emit(ctx, api.Event{Kind: "history.added", Session: s.id, Turn: cp.Turn, Step: cp.Step, Call: cp.Call, Actor: i.actor, Data: api.JSON(entry)})
	i.c.Emit(ctx, api.Event{Kind: "tool.end", Session: s.id, Turn: cp.Turn, Step: cp.Step, Call: cp.Call, Actor: i.actor, Data: api.JSON(result)})
	if result.ProcessingError != nil {
		i.c.Emit(ctx, api.Event{Kind: "plugin.problem", Session: s.id, Turn: cp.Turn, Call: cp.Call, Data: api.JSON("Tool result processing failed.")})
	}
	s.mu.Lock()
	i.c.h.startInterfaceContinuationsLocked(s)
	s.mu.Unlock()
	return InterfaceAccepted, result.ProcessingError
}

func (i *InterfaceConnection) checkReportLocked(ctx context.Context, id string) (api.Entry, api.Call, string, error) {
	s := i.s
	refuse := func() (api.Entry, api.Call, string, error) { return api.Entry{}, api.Call{}, InterfaceRefused, nil }
	if ctx.Err() != nil || !i.allowedLocked("watch", nil) || !i.allowedLocked("tools", nil) {
		return refuse()
	}
	if err := s.reconcileErasureLocked(); err != nil {
		return api.Entry{}, api.Call{}, InterfaceRefused, err
	}
	cp := api.InterfaceHandoffs(s.data)[id]
	call, saved, ok := i.c.h.restoreInterface(s.data, cp)
	if !ok || saved.Actor != i.actor || saved.Route != i.route || !i.allowedLocked("watch", saved.Rights) || !i.allowedLocked("tools", saved.Rights) || s.checkWriterLocked() != nil {
		return refuse()
	}
	if terminal := interfaceTerminal(s.data, id); terminal.ID != "" {
		if terminal.Actor == i.actor && !terminal.IsErased() {
			return cp, call, InterfaceAlreadySettled, nil
		}
		return refuse()
	}
	if saved.Deadline <= worktime.Now().UnixMilli() {
		if err := i.c.h.settleInterfaceUnknownLocked(s, cp, "Interface result deadline expired; outcome unknown."); err != nil {
			return api.Entry{}, api.Call{}, InterfaceRefused, err
		}
		i.c.h.armInterfaceTimerLocked(s)
		i.c.h.startInterfaceContinuationsLocked(s)
		return refuse()
	}
	for _, e := range s.data.Branch() {
		if e.Turn != cp.Turn || !e.WasKind("turn.end") {
			continue
		}
		out := api.Decode[api.Outcome](e.Data)
		if !e.IsErased() && !s.interfaceUnreleased[id] && out.Status == "completed" &&
			slices.ContainsFunc(out.Open, func(c api.Call) bool { return c.ID == id }) {
			return cp, call, "", nil
		}
		return refuse()
	}
	return cp, call, InterfaceNotReady, nil
}

// WatchContinuation registers before an Interface commits an answer or report.
// No history entry or turn exists for a capacity refusal.
func (c *client) WatchContinuation(id, origin string) (<-chan struct{}, func(), error) {
	s, err := c.find(id)
	if err != nil {
		return nil, nil, err
	}
	ch := make(chan struct{})
	s.mu.Lock()
	if s.continuationWaiters == nil {
		s.continuationWaiters = make(map[chan struct{}]string)
	}
	s.continuationWaiters[ch] = origin
	s.mu.Unlock()
	return ch, func() { s.mu.Lock(); delete(s.continuationWaiters, ch); s.mu.Unlock() }, nil
}

// Interface and question completions use the same session run queue. Derive
// readiness from committed records; an in-memory queue entry is not admission.
func (h *Harness) queueInterfaceContinuationsLocked(s *session) {
	cps := api.InterfaceHandoffs(s.data)
	waits := api.WaitingApprovals(s.data)
	if s.closing || s.opening || (len(cps) == 0 || len(h.interfaceTools) == 0) && len(waits) == 0 || s.writerFailure != nil {
		return
	}
	type ready struct {
		at    int
		input api.Input
	}
	var readyTurns []ready
	started := map[string]bool{}
	for _, e := range s.data.LiveEntries() {
		if e.Kind == "turn.start" {
			started[api.Decode[api.TurnStart](e.Data).ContinuesTurn] = true
		}
		if e.IsErased() && e.WasKind("turn.start") {
			started[e.Turn] = true
		}
	}
	branch := s.data.Branch()
	starts := map[string]api.Entry{}
	results := map[string]api.Entry{}
	positions := map[string]int{}
	type question struct {
		q      api.Question
		closed api.Entry
	}
	questions := map[string]question{}
	for idx, e := range branch {
		positions[e.ID] = idx
		switch e.Kind {
		case "turn.start":
			starts[e.Turn] = e
		case "tool.result":
			results[e.Call] = e
		case "question.open":
			q := api.Decode[struct{ Question api.Question }](e.Data).Question
			if q.ID != "" && (q.Defer && q.Kind != "approval" || q.ApprovalWait == api.UntilDeadline) {
				questions[q.ID] = question{q: q}
			}
		case "question.answer":
			id := api.Decode[api.Answer](e.Data).Request
			if q, ok := questions[id]; ok {
				q.closed = e
				questions[id] = q
			}
		}
	}
	for _, end := range branch {
		if end.Kind != "turn.end" || started[end.Turn] || s.queuedContinuations[end.Turn] || starts[end.Turn].ID == "" {
			continue
		}
		out := api.Decode[api.Outcome](end.Data)
		if out.Status != "completed" {
			continue
		}
		var rerun []api.Call
		var latest api.TurnStarter
		at := -1
		eligible, hasInterface := true, false
		add := func(e api.Entry, kind, id string) {
			if positions[e.ID] > at {
				at, latest = positions[e.ID], api.TurnStarter{Kind: kind, ID: id}
			}
		}
		for _, c := range out.Open {
			if cp := cps[c.ID]; cp.ID != "" {
				hasInterface = true
				result := results[c.ID]
				// A retired/tombstoned checkpoint or result never supplies work.
				if cp.IsErased() || cp.Turn != end.Turn || result.ID == "" || !slices.Contains(result.Copies, cp.ID) {
					eligible = false
					break
				}
				if _, _, ok := h.restoreInterface(s.data, cp); !ok {
					eligible = false
					break
				}
				add(result, "toolResult", result.ID)
				continue
			}
			if w := waits[c.ID]; w != nil {
				hasInterface = true
				if w.Terminal.ID == "" {
					if w.Question.ApprovalCall == nil || w.Start.ID != "" {
						eligible = false
						break
					}
					_, orig := approvalResponse(s.data, end.Turn, api.Call{ID: c.ID, Name: w.Question.ApprovalCall.Name, Step: w.Request.Step})
					if orig.ID == "" {
						eligible = false
						break
					}
					c = orig
				}
			}
			hasQuestion := false
			for requestID, q := range questions {
				if q.q.Call != c.ID {
					continue
				}
				hasQuestion = true
				if q.closed.ID == "" || !api.HasQuestionCheckpoint(s.data, q.q) {
					eligible = false
					break
				}
				add(q.closed, "answer", requestID)
			}
			if !hasQuestion {
				eligible = false
				break
			}
			if !eligible {
				break
			}
			if interfaceTerminal(s.data, c.ID).ID == "" {
				rerun = append(rerun, c)
			}
		}
		if !eligible || !hasInterface || at < 0 {
			continue
		}
		input := turnAdmission(s.data, starts[end.Turn])
		// Never substitute the executor for the original work actor.
		if starts[end.Turn].Actor == "" {
			continue
		}
		input.Actor = starts[end.Turn].Actor
		if input.ID == "" && api.Decode[api.TurnStart](starts[end.Turn].Data).Input != "" {
			continue
		}
		input.ID, input.Key, input.Answer, input.When = "", "continue:"+end.Turn, "", "after"
		input.Continuation, input.ContinuedBy, input.Calls = end.Turn, latest, rerun
		input.TraceContext = s.interfaceParents[end.Turn]
		delete(s.interfaceParents, end.Turn)
		input.Content = nil
		readyTurns = append(readyTurns, ready{max(at, positions[end.ID]), input})
	}
	sort.SliceStable(readyTurns, func(i, j int) bool { return readyTurns[i].at < readyTurns[j].at })
	for _, r := range readyTurns {
		if s.queuedContinuations == nil {
			s.queuedContinuations = map[string]bool{}
		}
		s.queuedContinuations[r.input.Continuation] = true
		s.queue = append(s.queue, r.input)
	}
}

func (h *Harness) startInterfaceContinuationsLocked(s *session) {
	h.queueInterfaceContinuationsLocked(s)
	if s.running || s.closing || s.opening || s.writerFailure != nil {
		return
	}
	idx := slices.IndexFunc(s.queue, func(in api.Input) bool { return in.Continuation != "" })
	if idx < 0 {
		return
	}
	in := s.queue[idx]
	s.queue = slices.Delete(s.queue, idx, idx+1)
	s.running, s.activeActor, s.activeInput, s.done = true, in.Actor, in, make(chan struct{})
	ctx, cancel := context.WithCancelCause(context.Background())
	s.cancel = cancel
	go h.run(ctx, s, in)
}

// ContinueInterfaceWork is called after a question commits, for mixed origins.
func (c *client) ContinueInterfaceWork(id string) {
	s, err := c.find(id)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c.h.startInterfaceContinuationsLocked(s)
}
