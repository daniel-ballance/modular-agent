package harness

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"go.opentelemetry.io/otel/trace"
)

type approvalDelivery struct{ request, actor, principal, instance string }

func (h *Harness) ConfigureWaitingApprovals(ms int64) { h.maxApprovalWaitMs = ms }
func (h *Harness) SupportsWaitingApprovals() bool     { return h.maxApprovalWaitMs > 0 }
func (c *client) SupportsWaitingApprovals() bool      { return c.h.SupportsWaitingApprovals() }

// RegisterApprovalRoute installs a stateless route projection, not a connection.
func (h *Harness) RegisterApprovalRoute(binding string, check api.ApprovalRouteCheck) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.approvalRoutes == nil {
		h.approvalRoutes = map[string]api.ApprovalRouteCheck{}
	}
	h.approvalRoutes[binding] = check
}
func (c *client) RegisterApprovalRoute(route string, check api.ApprovalRouteCheck) {
	c.h.RegisterApprovalRoute(route, check)
}
func (h *Harness) unchanged(ctx context.Context, q api.Question, route string) bool {
	h.mu.RLock()
	check := h.approvalRoutes[route]
	h.mu.RUnlock()
	q.Answerable = false
	return check != nil && check(ctx, q, route)
}
func principal(ctx context.Context) string {
	if via := api.ActingVia(ctx); via != "" {
		return via
	}
	return api.Acting(ctx)
}
func (c *client) eligibleApprover(s api.Session, q api.Question, actor string) bool {
	return (q.Allowed == nil || slices.Contains(q.Allowed, actor)) && c.authorized(s, actor, "approve") && c.authorized(s, actor, "watch")
}
func (c *client) anyApprover(s api.Session, q api.Question) bool {
	for who := range actors(s) {
		if c.eligibleApprover(s, q, who) {
			return true
		}
	}
	return false
}

func approvalResponse(s api.Session, turn string, call api.Call) (api.Entry, api.Call) {
	for _, e := range s.Branch() {
		if e.Kind == "model" && e.Turn == turn && e.Step == call.Step {
			for _, part := range e.Content {
				if part.Call != nil && part.Call.ID == call.ID && part.Call.Name == call.Name {
					orig := *part.Call
					orig.Step, orig.Actor, orig.Origin = e.Step, e.Actor, "model"
					return e, orig
				}
			}
		}
	}
	return api.Entry{}, api.Call{}
}

func (c *client) ParkApproval(ctx context.Context, q api.Question) (bool, error) {
	// Only the built-in policy gate can create this checkpoint.
	if c.owner != "approval" || q.ApprovalCall == nil || q.ApprovalCall.Origin != "model" || q.ApprovalCall.ParentCall != "" || q.Turn == "" || q.Call == "" {
		return false, nil
	}
	s, err := c.find(q.Session)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	if err = s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return true, err
	}
	snap := s.data
	if w := api.WaitingApprovals(snap)[q.Call]; w != nil {
		s.mu.Unlock()
		// Never publish a replacement request for this identity. The ports
		// verify the immutable binding again at the first start and handoff.
		if w.End.ID == "" && w.Pending.ID != "" && w.Start.ID == "" && w.Terminal.ID == "" {
			return true, api.ErrQuestionOpen
		}
		if !w.Listed || w.Answer.Value != "allow" || w.Answer.Declined || w.Terminal.ID != "" || w.Start.ID != "" || !sameWaitingCall(w.Question, *q.ApprovalCall, q.Source, q.Definition) {
			return true, api.ErrAnswerAuthority
		}
		return true, nil
	}
	if !c.h.SupportsWaitingApprovals() || snap.Settings.ApprovalWait != api.UntilDeadline || snap.Parent != "" || c.h.interfaceTools[q.ApprovalCall.Name] != nil {
		s.mu.Unlock()
		return false, nil
	}
	for _, e := range snap.LiveEntries() {
		if e.Call == q.Call && (e.WasKind("tool.started") || e.WasKind("tool.result")) {
			s.mu.Unlock()
			return false, nil
		}
	}
	q.Step = q.ApprovalCall.Step
	response, _ := approvalResponse(snap, q.Turn, *q.ApprovalCall)
	if response.ID == "" || !offeredInterface(snap, q.Turn, *q.ApprovalCall) || q.Source == nil || q.Definition == nil || !c.anyApprover(snap, q) {
		s.mu.Unlock()
		return true, api.ErrAnswerAuthority
	}
	ms := c.h.maxApprovalWaitMs
	if q.Wait > 0 {
		ms = min(ms, max(1, q.Wait.Milliseconds()))
	}
	q.ID = api.ID()
	q.ApprovalWait = api.UntilDeadline
	q.Answerable = false
	q.Wait = 0
	q.ApprovalIntervalMs = ms
	next := snap
	next.Entries = slices.Clip(next.Entries)
	r := appendEntry(&next, api.Entry{ID: q.ID, Kind: "question.open", Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: q.Actor, Copies: []string{response.ID}}, "harness", true)
	deadline := time.UnixMilli(r.Time.UnixMilli() + ms).UTC()
	if deadline.UnixMilli() > 9007199254740991 || deadline.Year() > 9999 {
		s.mu.Unlock()
		return true, errors.New("unrepresentable approval deadline")
	}
	q.Deadline = &deadline
	r.Data = api.JSON(struct{ Question api.Question }{q})
	next.Entries[len(next.Entries)-1] = r
	pending := appendEntry(&next, api.Entry{Kind: "tool.open", Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: q.Actor, Data: api.JSON(map[string]any{"requestIds": []string{q.ID}}), Copies: []string{r.ID}}, "harness", true)
	err = s.commitLocked(next, ctx)
	if err == nil {
		c.h.armApprovalTimerLocked(s)
	}
	s.mu.Unlock()
	if err != nil {
		return true, err
	}
	for _, e := range []api.Entry{r, pending} {
		c.Emit(ctx, api.Event{Kind: "history.added", Session: s.id, Turn: e.Turn, Step: e.Step, Call: e.Call, Actor: e.Actor, Data: api.JSON(e)})
	}
	telemetry.Event(ctx, "modular_agent.question.open", telemetry.String("modular_agent.question.id", q.ID), telemetry.String("modular_agent.question.kind", "approval"))
	c.Emit(ctx, api.Event{Kind: "question.open", Session: s.id, Turn: q.Turn, Step: q.Step, Call: q.Call, Data: api.JSON(q)})
	return true, api.ErrQuestionOpen
}

func sameWaitingCall(q api.Question, c api.Call, source *api.ToolRegistration, def *api.Tool) bool {
	a := q.ApprovalCall
	return a != nil && a.ID == c.ID && a.Actor == c.Actor && q.Actor == c.Actor && a.Name == c.Name && c.ParentCall == "" && c.Origin == "model" && q.Step == c.Step && portable.EqualJSON(a.Input, c.Input) && q.Source != nil && source != nil && *q.Source == *source && q.Definition != nil && def != nil && portable.EqualJSON(definitionJSON(*q.Definition), definitionJSON(*def))
}
func definitionJSON(t api.Tool) []byte {
	if len(t.Wire) > 0 {
		return t.Wire
	}
	return api.JSON(portable.Tool(t))
}

func (c *client) validWait(s api.Session, w *api.WaitingApproval) bool {
	q := w.Question
	if w.InvalidDecision || q.Kind != "approval" || q.ApprovalWait != api.UntilDeadline || q.Defer || q.Answerable || q.ID == "" || q.Session != s.ID || q.Call != w.Request.Call || q.Turn != w.Request.Turn || q.Step != w.Request.Step || q.ApprovalIntervalMs <= 0 || q.ApprovalIntervalMs > c.h.maxApprovalWaitMs || q.Deadline == nil || q.Deadline.UnixMilli() != w.Request.Time.UnixMilli()+q.ApprovalIntervalMs || q.ApprovalCall == nil || q.ApprovalCall.ID != q.Call || q.Definition == nil || q.Source == nil || s.Settings.ApprovalWait != api.UntilDeadline || w.Pending.ID == "" {
		return false
	}
	call := *q.ApprovalCall
	call.Step = q.Step
	resp, orig := approvalResponse(s, q.Turn, call)
	if resp.Actor != q.Actor || orig.Name != call.Name || q.Source.Plugin == "" || q.Source.ToolSource == "" || q.Definition.Name != call.Name {
		return false
	}
	return resp.ID != "" && slices.Contains(w.Request.Copies, resp.ID) && offeredInterface(s, q.Turn, call)
}
func (c *client) answerableLocked(ctx context.Context, s *session, w *api.WaitingApproval) bool {
	return w != nil && w.Listed && w.Decision.ID == "" && w.Start.ID == "" && w.Terminal.ID == "" && !s.closing && c.validWait(s.data, w) && worktime.Now().Before(*w.Question.Deadline) && c.eligibleApprover(s.data, w.Question, api.Acting(ctx)) && c.authorizedBy(s.data, ctx, "approve") && c.authorizedBy(s.data, ctx, "watch") && ctx.Err() == nil && s.checkWriterLocked() == nil
}
func (c *client) PresentApproval(ctx context.Context, q api.Question, route, instance string) bool {
	s, err := c.find(q.Session)
	if err != nil || instance == "" {
		return false
	}
	key := approvalDelivery{q.ID, api.Acting(ctx), principal(ctx), instance}
	// Reread the authoritative view. Do not take an Interface's copy as proof.
	read := func() (*api.WaitingApproval, bool) {
		if s.reconcileErasureLocked() != nil {
			return nil, false
		}
		w := api.WaitingApprovals(s.data)[q.Call]
		return w, c.answerableLocked(ctx, s, w) && w.Question.ID == q.ID
	}
	s.mu.Lock()
	delete(s.approvalDeliveries, key)
	w, ok := read()
	s.mu.Unlock()
	if !ok || !c.h.unchanged(ctx, w.Question, route) {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	after, ok := read()
	if !ok || after.Request.ID != w.Request.ID {
		return false
	}
	if s.approvalDeliveries == nil {
		s.approvalDeliveries = map[approvalDelivery]string{}
	}
	s.approvalDeliveries[key] = route
	return true
}
func (c *client) ForgetApprovalRoute(session, instance string) {
	s, err := c.find(session)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for key := range s.approvalDeliveries {
		if key.instance == instance {
			delete(s.approvalDeliveries, key)
		}
	}
}
func (c *client) AnswerWaiting(ctx context.Context, id, instance string, a api.Answer) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	key := approvalDelivery{a.Request, api.Acting(ctx), principal(ctx), instance}
	s.mu.Lock()
	if err = s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	if err = c.h.reconcileApprovalsLocked(ctx, s); err != nil {
		s.mu.Unlock()
		return err
	}
	var w *api.WaitingApproval
	for _, p := range api.WaitingApprovals(s.data) {
		if p.Question.ID == a.Request {
			w = p
			break
		}
	}
	if w == nil || w.Decision.ID != "" || w.Terminal.ID != "" {
		s.mu.Unlock()
		return api.ErrQuestionNotFound
	}
	route := s.approvalDeliveries[key]
	ok := c.answerableLocked(ctx, s, w) && route != ""
	s.mu.Unlock()
	if !ok {
		return api.ErrAnswerAuthority
	}
	unchanged := c.h.unchanged(ctx, w.Question, route)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !unchanged {
		delete(s.approvalDeliveries, key)
		return api.ErrAnswerAuthority
	}
	if err = s.reconcileErasureLocked(); err != nil {
		return err
	}
	if err = c.h.reconcileApprovalsLocked(ctx, s); err != nil {
		return err
	}
	w = api.WaitingApprovals(s.data)[w.Question.Call]
	if w == nil || w.Decision.ID != "" || w.Terminal.ID != "" {
		return api.ErrQuestionNotFound
	}
	if s.approvalDeliveries[key] != route || !c.answerableLocked(ctx, s, w) {
		return api.ErrAnswerAuthority
	}
	a.Actor, a.Via, a.ApprovalView = key.actor, nil, nil
	if a.Value == "refuse" {
		a.Declined = true
	}
	if a.Declined {
		a.Value = ""
	} else if a.Value != "allow" {
		return api.ErrInvalidAnswer
	} else {
		var rights []string
		for _, r := range api.Rights {
			if c.authorizedBy(s.data, ctx, r) {
				rights = append(rights, r)
			}
		}
		a.ApprovalView = &api.ApprovalView{RequestEntryID: w.Request.ID, SubmittedBy: key.principal, RouteID: route, Rights: rights}
	}
	status := ""
	if a.Declined {
		status = "refused"
	}
	if err = c.h.decideApprovalLocked(ctx, s, w, &a, status); err != nil {
		return err
	}
	c.h.armApprovalTimerLocked(s)
	c.h.startInterfaceContinuationsLocked(s)
	return nil
}

func (h *Harness) decideApprovalLocked(ctx context.Context, s *session, w *api.WaitingApproval, answer *api.Answer, status string) error {
	q := w.Question
	ctx = telemetry.Scope(ctx, s.id, q.Turn, q.Step, h.agentName)
	if !trace.SpanFromContext(ctx).IsRecording() {
		var span trace.Span
		ctx, span = telemetry.Start(ctx, "modular_agent.question.answer")
		defer span.End()
	}
	next := s.data
	next.Entries = slices.Clip(next.Entries)
	sources := []string{w.Request.ID}
	decision := w.Decision
	if answer != nil && decision.ID == "" {
		decision = appendEntry(&next, api.Entry{Kind: "question.answer", Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: answer.Actor, OperatorAdmission: answer.Actor == "", Copies: slices.Clone(sources), Data: api.JSON(answer)}, "harness", true)
	}
	if decision.ID != "" {
		sources = append(sources, decision.ID)
	}
	if status != "" && w.Terminal.ID == "" {
		r := api.ToolResult{Call: q.Call, Status: status, Content: api.Text("Waiting approval did not authorize dispatch.")}
		if q.ApprovalCall != nil {
			r.Name = q.ApprovalCall.Name
			r.Reference = q.ApprovalCall.Reference
		}
		turn := q.Turn
		if start := s.data.UnfinishedTurn(); start != nil && api.Decode[api.TurnStart](start.Data).ContinuesTurn == q.Turn {
			turn = start.Turn
		}
		appendEntry(&next, api.Entry{Kind: "tool.result", Turn: turn, Step: q.Step, Call: q.Call, Actor: q.Actor, Visible: true, Data: api.JSON(r), Content: r.Content, Copies: sources}, "harness", true)
	}
	if err := s.commitLocked(next, ctx); err != nil {
		return err
	}
	for key := range s.approvalDeliveries {
		if key.request == q.ID {
			delete(s.approvalDeliveries, key)
		}
	}
	if answer != nil && w.Decision.ID == "" {
		disposition := "answered"
		if answer.Declined {
			disposition = "declined"
			if answer.Actor == "" {
				disposition = answer.Reason
			}
		}
		telemetry.Event(ctx, "modular_agent.question.close", telemetry.String("modular_agent.question.id", q.ID), telemetry.String("modular_agent.question.kind", "approval"), telemetry.String("modular_agent.question.disposition", disposition))
	}
	if status != "" && q.ApprovalCall != nil {
		toolDisposition(ctx, *q.ApprovalCall, status)
	}
	return nil
}
func (h *Harness) reconcileApprovalsLocked(ctx context.Context, s *session) error {
	c := &client{h: h}
	for _, w := range api.WaitingApprovals(s.data) {
		if w.Terminal.ID != "" || w.Start.ID != "" {
			continue
		}
		q := w.Question
		reason, status := "", ""
		switch {
		case !h.SupportsWaitingApprovals():
			reason, status = "noLongerAnswerable", "not_started"
		case q.Deadline != nil && !worktime.Now().Before(*q.Deadline):
			reason, status = "timeLimit", "not_started"
		case w.End.ID != "" && !w.Listed:
			reason, status = "cancelled", "not_started"
		case !c.validWait(s.data, w):
			reason, status = "refused", "refused"
		case !c.anyApprover(s.data, q):
			reason, status = "noLongerAnswerable", "refused"
		case w.Answer.Declined:
			status = "refused"
		case w.Decision.ID != "" && (w.Answer.ApprovalView == nil || !c.eligibleApprover(s.data, q, w.Answer.Actor) || !c.authorized(s.data, w.Answer.ApprovalView.SubmittedBy, "approve") || !c.authorized(s.data, w.Answer.ApprovalView.SubmittedBy, "watch")):
			status = "refused"
		}
		if status != "" {
			var a *api.Answer
			if w.Decision.ID == "" {
				a = &api.Answer{Request: q.ID, Declined: true, Reason: reason}
			}
			if err := h.decideApprovalLocked(ctx, s, w, a, status); err != nil {
				return err
			}
		}
	}
	return nil
}
func (h *Harness) afterApprovalChangeLocked(ctx context.Context, s *session) error {
	waits := api.WaitingApprovals(s.data)
	if len(waits) == 0 {
		return nil
	}
	c := &client{h: h}
	for k := range s.approvalDeliveries {
		valid := false
		for _, w := range waits {
			if w.Question.ID == k.request && c.eligibleApprover(s.data, w.Question, k.actor) && c.authorized(s.data, k.principal, "approve") && c.authorized(s.data, k.principal, "watch") {
				valid = true
				break
			}
		}
		if !valid {
			delete(s.approvalDeliveries, k)
		}
	}
	if err := h.reconcileApprovalsLocked(ctx, s); err != nil {
		return err
	}
	h.armApprovalTimerLocked(s)
	h.startInterfaceContinuationsLocked(s)
	return nil
}

func (p *turnPorts) waitingProof(ctx context.Context, s api.Session, c api.Call, binding *api.ToolRegistration, def *api.Tool, afterStart bool) ([]string, error) {
	w := api.WaitingApprovals(s)[c.ID]
	if w == nil {
		return nil, nil
	}
	a := w.Answer
	proof := a.ApprovalView
	if w.Question.Deadline != nil && !worktime.Now().Before(*w.Question.Deadline) {
		return nil, api.ErrApprovalExpired
	}
	if !p.c.validWait(s, w) || !w.Listed || w.Terminal.ID != "" || (w.Start.ID != "" && (!afterStart || w.Start.Turn != p.id)) || s.Settings.Approval == "never" || !knownApproval(s.Settings.Approval) || a.Declined || a.Value != "allow" || proof == nil || proof.RequestEntryID != w.Request.ID || proof.SubmittedBy == "" || !sameWaitingCall(w.Question, c, binding, def) || !slices.Contains(proof.Rights, "watch") || !slices.Contains(proof.Rights, "approve") {
		return nil, api.ErrAnswerAuthority
	}
	origin := ""
	for _, e := range s.Branch() {
		if e.Kind == "turn.start" && e.Turn == p.id {
			origin = api.Decode[api.TurnStart](e.Data).ContinuesTurn
		}
	}
	if origin != w.Request.Turn || !p.workStillAuthorized(s, w) || !p.canRunTools(c.Actor) || !p.c.eligibleApprover(s, w.Question, a.Actor) || !p.c.authorized(s, proof.SubmittedBy, "approve") || !p.c.authorized(s, proof.SubmittedBy, "watch") || validateToolInput(*def, c.Input) != nil {
		return nil, api.ErrAnswerAuthority
	}
	viewCtx := api.WithConnectionRights(api.WithActingVia(api.AsActor(ctx, a.Actor), proof.SubmittedBy), &proof.Rights)
	if !p.c.h.unchanged(viewCtx, w.Question, proof.RouteID) {
		return nil, api.ErrAnswerAuthority
	}
	sources := []string{w.Request.ID, w.Decision.ID}
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	return sources, p.finalWaitingLocked(ctx, c, sources, afterStart)
}

// Output and registration checks can call other parts. Do not hold the session
// lock across them. Fence the interval they took before committing a start or
// handing the checked call to its executor.
func (p *turnPorts) finalWaitingLocked(ctx context.Context, c api.Call, sources []string, afterStart bool) error {
	s := p.s
	if err := s.reconcileErasureLocked(); err != nil {
		return err
	}
	if err := s.checkWriterLocked(); err != nil {
		return err
	}
	w := api.WaitingApprovals(s.data)[c.ID]
	if ctx.Err() != nil || s.closing || w == nil || w.Request.ID != sources[0] || w.Decision.ID != sources[1] || w.Answer.ApprovalView == nil {
		return api.ErrAnswerAuthority
	}
	if !worktime.Now().Before(*w.Question.Deadline) {
		return api.ErrApprovalExpired
	}
	who := w.Answer.ApprovalView.SubmittedBy
	if !p.c.validWait(s.data, w) || w.Terminal.ID != "" || w.Start.ID != "" && (!afterStart || w.Start.Turn != p.id) || !p.canRunToolsLocked(c.Actor) || !p.workStillAuthorized(s.data, w) || !knownApproval(s.data.Settings.Approval) || !p.c.eligibleApprover(s.data, w.Question, w.Answer.Actor) || !p.c.authorized(s.data, who, "watch") || !p.c.authorized(s.data, who, "approve") {
		return api.ErrAnswerAuthority
	}
	return nil
}

// A portable admission may name more authorizers than this SDK put on its
// own input. Check them under their recorded scope as well as the local
// admission, connection and job ceilings. An unknown scope is not authority.
func (p *turnPorts) workStillAuthorized(s api.Session, w *api.WaitingApproval) bool {
	var work api.Input
	for _, e := range s.Branch() {
		if e.Kind == "turn.start" && e.Turn == w.Question.Turn {
			work = turnAdmission(s, e)
			break
		}
	}
	if work.ID == "" || work.ConnectionRights == nil && work.JobRights == nil {
		return false
	}
	for _, e := range s.LiveEntries() {
		if e.Kind != "input.accepted" || api.Decode[api.Input](e.Data).ID != work.ID {
			continue
		}
		var d struct {
			Data struct {
				Authorizers []struct{ SessionID, ActorID, JobID string }
			}
		}
		if len(e.Wire) == 0 {
			return true
		}
		if err := json.Unmarshal(e.Wire, &d); err != nil {
			return false
		}
		for _, ref := range d.Data.Authorizers {
			who := ref.ActorID
			if ref.JobID != "" {
				if who != "" {
					return false
				}
				who = "job:" + ref.JobID
			}
			snap := s
			if ref.SessionID != s.ID {
				var err error
				snap, err = p.c.Snapshot(ref.SessionID)
				if err != nil || snap.Project != s.Project || snap.Tenant != s.Tenant {
					return false
				}
			}
			if !p.c.authorized(snap, who, "tools") {
				return false
			}
		}
		return true
	}
	return false
}
func knownApproval(v string) bool {
	return v == "" || v == "off" || v == "ask-always" || v == "ask-unless-read-only"
}
func (p *turnPorts) checkWaiting(ctx context.Context, c api.Call, afterStart bool) ([]string, error) {
	if !p.c.h.SupportsWaitingApprovals() {
		return nil, nil
	}
	plugin, source, def, _, snap, ok := p.resolveTool(c.Name)
	if api.WaitingApprovals(snap)[c.ID] == nil {
		return nil, nil
	}
	if !ok {
		return nil, api.ErrAnswerAuthority
	}
	return p.waitingProof(ctx, snap, c, &api.ToolRegistration{Plugin: plugin, ToolSource: source}, &def, afterStart)
}

func (h *Harness) armApprovalTimerLocked(s *session) {
	if s.approvalTimer != nil {
		s.approvalTimer.Stop()
		s.approvalTimer = nil
	}
	if !h.SupportsWaitingApprovals() || s.closing || s.writerFailure != nil {
		return
	}
	var next *time.Time
	for _, w := range api.WaitingApprovals(s.data) {
		if d := w.Question.Deadline; w.Start.ID == "" && w.Terminal.ID == "" && d != nil && (next == nil || d.Before(*next)) {
			next = d
		}
	}
	if next == nil {
		return
	}
	var timer worktime.Timer
	timer = worktime.At(*next, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.approvalTimer != timer || s.closing || s.writerFailure != nil || s.reconcileErasureLocked() != nil || h.reconcileApprovalsLocked(context.Background(), s) != nil {
			return
		}
		h.armApprovalTimerLocked(s)
		h.startInterfaceContinuationsLocked(s)
	})
	s.approvalTimer = timer
}
