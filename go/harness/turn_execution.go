package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"slices"
)

func recordedOutcome(snap api.Session) api.Outcome {
	var out api.Outcome
	for _, entry := range snap.Branch() {
		if entry.Kind == "turn.end" {
			out = api.Decode[api.Outcome](entry.Data)
		}
	}
	return out
}

func (h *Harness) run(ctx context.Context, s *session, in api.Input) {
	for {
		outcome := h.runOne(ctx, s, in)
		s.mu.Lock()
		if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) && (ctx.Err() != nil || outcome.Status == "cancelled") {
			outcome.Returned = nil
			var continuations []api.Input
			for _, queued := range s.queue {
				if queued.Continuation != "" {
					continuations = append(continuations, queued)
				} else {
					outcome.Returned = append(outcome.Returned, queued)
				}
			}
			if len(outcome.Returned) > 0 {
				next := s.data
				next.Entries = slices.Clip(next.Entries)
				for _, queued := range outcome.Returned {
					appendEntry(&next, api.Entry{Kind: "input.returned", Actor: queued.Actor, InputRef: queued.ID,
						Data: api.JSON("cancelled")}, "harness", true)
				}
				if err := s.commitLocked(next); err != nil {
					outcome.Error = err.Error()
				}
			}
			s.queue = continuations
		}
		s.last = outcome
		h.queueInterfaceContinuationsLocked(s)
		nextInput := runnableInput(s.queue)
		if nextInput < 0 || s.closing || s.writerFailure != nil || ctx.Err() != nil {
			s.running = false
			s.cancel(nil)
			done := s.done
			if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
				h.startInterfaceContinuationsLocked(s)
			}
			s.mu.Unlock()
			if len(outcome.Returned) > 0 {
				h.API().Emit(context.Background(), api.Event{Kind: "input.returned", Session: s.id, Data: api.JSON(outcome.Returned)})
			}
			close(done)
			return
		}
		in = s.queue[nextInput]
		s.queue = slices.Delete(s.queue, nextInput, nextInput+1)
		s.mu.Unlock()
	}
}
func (h *Harness) runOne(ctx context.Context, s *session, in api.Input) (out api.Outcome) {
	defer func() {
		if p := recover(); p != nil {
			out = api.Outcome{Status: "failed", Error: fmt.Sprintf("Runtime panic: %v", p)}
		}
	}()
	s.mu.Lock()
	if len(s.external) > 0 {
		calls := s.external
		s.external = nil
		s.mu.Unlock()
		return h.runExternal(ctx, s, calls)
	}
	resume := s.resume
	s.steeringClosed = false
	s.activeActor, s.activeInput = in.Actor, in
	s.resume = nil
	if resume != nil {
		in = turnAdmission(s.data, *resume)
		if resume.Actor != "" {
			in.Actor = resume.Actor
		} else if in.Actor == "" {
			start := api.Decode[api.TurnStart](resume.Data)
			if start.StartedBy.Kind == "actor" {
				for _, e := range s.data.Branch() {
					if e.Turn == resume.Turn && e.Kind == "input" && e.Actor == start.StartedBy.ID {
						in.Actor = e.Actor
						break
					}
				}
			}
		}
		s.activeActor, s.activeInput = in.Actor, in
	}
	if in.Continuation != "" {
		in.Calls = slices.DeleteFunc(slices.Clone(in.Calls), func(c api.Call) bool { return interfaceTerminal(s.data, c.ID).ID != "" })
	}
	snap := copySession(s.data)
	s.mu.Unlock()
	v, err := h.API().Get("runtime")
	if err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	runtime := v.(api.Runtime)
	selection, err := h.API().Get("selection")
	if err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	selectionView := snap
	if resume != nil {
		selectionView.Settings = api.Decode[api.TurnStart](resume.Data).Settings
	}
	access, resolveErr := selection.(api.Selection).Resolve(selectionView)
	turnID := api.ID()
	if resume != nil {
		turnID = resume.Turn
	}
	ctx = telemetry.Scope(telemetry.WorkParent(ctx, in.TraceContext), snap.ID, turnID, "", h.agentName)
	ctx = api.WithExecution(api.AsActor(ctx, in.Actor), api.Execution{Session: snap.ID, Turn: turnID})
	ctx = api.WithJobContributors(api.WithConnectionRights(ctx, in.ConnectionRights), in.Actor, in.ViaActor, in.ReleasedBy)
	var tools []api.Tool
	seen := map[string]bool{}
	for _, source := range h.API().All("tools.") {
		for _, tool := range source.(api.ToolSource).Tools(snap) {
			if seen[tool.Name] {
				return api.Outcome{Status: "failed", Error: "duplicate tool " + tool.Name}
			}
			seen[tool.Name] = true
			if registered := h.interfaceTools[tool.Name]; registered != nil && (access != nil && access.Model().RunsTools || !runtime.Declaration().InterfaceTools || !h.interfaceAvailable(s, registered, tool.Name, in, turnID)) {
				continue
			}
			tools = append(tools, tool)
		}
	}
	before := api.BeforeTurn{Session: snap, Turn: turnID, Input: in.Content, Tools: tools}
	prepared := any(before)
	if resume == nil {
		prepared, err = h.API().Invoke(ctx, "turn.prepare", before)
	} else {
		recorded := api.Decode[api.TurnStart](resume.Data)
		// Do not add newly registered tools to a saved offer.
		tools = slices.DeleteFunc(tools, func(t api.Tool) bool {
			return !slices.ContainsFunc(recorded.Tools, func(saved api.Tool) bool {
				return saved.Name == t.Name && portable.EqualJSON(api.JSON(portable.Tool(saved)), api.JSON(portable.Tool(t)))
			})
		})
	}
	if err != nil {
		if ctx.Err() != nil && !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			if in.ID != "" && resume == nil {
				_, recordErr := h.API().Record(context.Background(), s.id, api.Entry{Kind: "input.returned", InputRef: in.ID, Data: api.JSON("cancelled")})
				if recordErr != nil {
					return api.Outcome{Status: "cancelled", Error: recordErr.Error()}
				}
			}
			return api.Outcome{Status: "cancelled", Error: ctx.Err().Error()}
		}
		if h.handBackOnOpen {
			h.mu.RLock()
			owner := h.caps["runtime"].owner
			h.mu.RUnlock()
			ports := &turnPorts{c: &client{h: h, owner: owner}, s: s, id: turnID, actor: in.Actor, input: in}
			return unavailableTurn(ctx, ports, selectionView.Settings, before, nil, resume, err)
		}
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	h.mu.RLock()
	owner := h.caps["runtime"].owner
	h.mu.RUnlock()
	ports := &turnPorts{c: &client{h: h, owner: owner}, s: s, id: turnID, actor: in.Actor, input: in, tools: tools}
	if err := ports.CheckTenantBudget(); err != nil {
		return unavailableTurn(ctx, ports, selectionView.Settings, prepared.(api.BeforeTurn), tools, resume, err)
	}
	if resolveErr != nil {
		return unavailableTurn(ctx, ports, selectionView.Settings, prepared.(api.BeforeTurn), tools, resume, resolveErr)
	}
	ports.model = access.Model()
	turn := api.Turn{ID: ports.id, Session: snap.ID, Actor: in.Actor, Input: in.ID, Settings: snap.Settings, System: prepared.(api.BeforeTurn).System, Context: prepared.(api.BeforeTurn).Context, Access: access, Tools: tools, IO: ports, CanRepeat: true}
	turn.Reopen, turn.Continuing = in.Calls, len(in.Calls) > 0 || in.Continuation != ""
	turn.StartedBy = api.TurnStarter{Kind: "actor", ID: in.Actor}
	if in.Continuation != "" {
		turn.StartedBy = in.ContinuedBy
	} else if in.Job != "" {
		turn.StartedBy = api.TurnStarter{Kind: "job", ID: in.Job}
	} else if turn.Continuing {
		answer := in.Answer
		if answer == "" {
			answer = in.ID
		}
		turn.StartedBy = api.TurnStarter{Kind: "answer", ID: answer}
	}
	if resume != nil {
		start := api.Decode[api.TurnStart](resume.Data)
		turn.ID, ports.id = resume.Turn, resume.Turn
		turn.Actor, ports.actor = in.Actor, in.Actor
		turn.Input, turn.Settings, turn.Resume = start.Input, selectionView.Settings, true
		if turn.Input == "" {
			for _, e := range snap.Branch() {
				if e.Turn == turn.ID && e.Kind == "input" {
					turn.Input = e.InputID()
					break
				}
			}
		}
		turn.Reopen = start.Calls
		if len(turn.Reopen) == 0 && start.StartedBy.Kind == "answer" {
			for _, c := range api.OpenCalls(snap) {
				if c.Step != "" {
					turn.Reopen = append(turn.Reopen, c)
				}
			}
		}
		if start.StartedBy.Kind != "" {
			turn.StartedBy = start.StartedBy
		}
		turn.System, turn.Context = start.System, start.Context
	}
	if env, err := h.API().Get("working-environment"); err == nil {
		turn.CanRepeat = env.(api.WorkingEnvironment).StopsOnCrash()
	}
	turn.Settings.Thinking = api.LowerReasoning(turn.Settings.Thinking, access.Model().Thinking)
	return h.runTraced(ctx, ports, turn, resume, snap, runtime)
}
func (c *client) CancelAs(ctx context.Context, id string) error {
	if !c.Authorize(id, api.Acting(ctx), "cancel") {
		return errors.New("cancel refused")
	}
	return c.cancel(ctx, id)
}
func (c *client) Cancel(id string) error { return c.cancel(context.Background(), id) }

func (c *client) cancel(ctx context.Context, id string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		s.cancel(context.Canceled)
	}
	for _, w := range api.WaitingApprovals(s.data) {
		if w.Start.ID == "" && w.Terminal.ID == "" {
			a := api.Answer{Request: w.Question.ID, Declined: true, Reason: "cancelled"}
			if err := c.h.decideApprovalLocked(ctx, s, w, &a, "not_started"); err != nil {
				return err
			}
		}
	}
	c.h.armApprovalTimerLocked(s)
	if err := c.h.settleInterfacesLocked(s, "", "Interface call cancelled before its outcome was known."); err != nil {
		return err
	}
	c.h.startInterfaceContinuationsLocked(s)
	return nil
}
func (c *client) Wait(ctx context.Context, id string) (api.Outcome, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Outcome{}, err
	}
	for {
		s.mu.Lock()
		running, done, last, failure := s.running, s.done, clone(s.last), s.writerFailure
		s.mu.Unlock()
		if failure != nil {
			return api.Outcome{}, failure
		}
		if !running {
			if done != nil {
				select {
				case <-done:
				default:
					select {
					case <-done:
						continue
					case <-ctx.Done():
						return api.Outcome{}, ctx.Err()
					}
				}
			}
			out, gateErr := c.OutputValue(ctx, api.Event{Kind: "turn.outcome", Session: id, Data: api.JSON(last)})
			if gateErr != nil {
				return api.Outcome{}, gateErr
			}
			return api.Decode[api.Outcome](out.Data), nil
		}
		select {
		case <-ctx.Done():
			return api.Outcome{}, ctx.Err()
		case <-done:
		case <-s.interrupted:
		}
	}
}

type turnPorts struct {
	c         *client
	s         *session
	id, actor string
	input     api.Input
	model     api.Model
	tools     []api.Tool
}

func (p *turnPorts) Hook(ctx context.Context, name string, v any) (any, error) {
	ctx = api.WithExecution(api.AsActor(ctx, p.actor), api.Execution{Session: p.s.id, Turn: p.id})
	if name == "runtime.tool.before" {
		check := v.(api.ToolCheck)
		if p.c.h.approvalCoversNested && check.Call.ParentCall == "" {
			// Both gate passes belong to one attempt; a repeat enters Hook anew.
			check.ApprovalAttempt = api.ID()
			v = check
		}
		if !p.canRunTools(check.Call.Actor) {
			return nil, errors.New("tool authority refused")
		}
		ctx = api.WithExecution(ctx, api.Execution{Session: p.s.id, Turn: p.id, Call: check.Call, ToolSource: p.toolRegistration(check.Call.Name)})
		changed, err := p.c.Invoke(ctx, name, v)
		if err != nil {
			return nil, err
		}
		check = changed.(api.ToolCheck)
		if (p.c.h.approvalCoversNested || check.Call.ParentCall != "" || p.c.h.interfaceTools[check.Call.Name] != nil) && check.InputChanged && !check.Open && check.Refused == "" {
			check.InputChanged, check.Validate, check.LiveApproval = false, nil, nil
			ctx = api.WithExecution(ctx, api.Execution{Session: p.s.id, Turn: p.id, Call: check.Call, ToolSource: p.toolRegistration(check.Call.Name)})
			changed, err = p.c.Invoke(ctx, name, check)
			if err != nil {
				return nil, err
			}
			check = changed.(api.ToolCheck)
			if check.InputChanged {
				return nil, errors.New("tool gate changed input on its second pass")
			}
		}
		validate := check.Validate
		check.Validate = func(call api.Call) error {
			if validate != nil {
				if err := validate(call); err != nil {
					return err
				}
			}
			// A served Runtime's before-gate RPC ends before it requests handoff.
			// The start write and RunTool check the live dispatch context separately.
			if _, err := p.checkWaiting(context.WithoutCancel(ctx), call, true); err != nil {
				return err
			}
			if !p.canRunTools(call.Actor) {
				return errors.New("tool authority refused")
			}
			return nil
		}
		return check, nil
	}
	if name == "runtime.result" {
		check := v.(api.ResultCheck)
		check.Shape = p.input.ResultSchema
		if len(check.Shape) != 0 && len(check.Value) == 0 {
			text := json.RawMessage(check.Result.Text())
			if json.Valid(text) {
				check.Value = text
			}
		}
		v = check
	}
	changed, err := p.c.Invoke(ctx, name, v)
	if name == "runtime.tool.after" {
		before := v.(api.AfterTool)
		result := before.Result
		if err == nil {
			after := changed.(api.AfterTool).Result
			result.Content, result.Structured = after.Content, after.Structured
			err = api.ValidateToolResult(result)
		}
		if err != nil {
			// Preserve the fact and status of dispatch, not the unchecked output.
			result.Content = api.Text("Tool result processing failed.")
			result.Structured, result.Data, result.Wire = nil, nil, nil
			result.ProcessingError = errors.Join(result.ProcessingError, err)
		}
		// Validate the original result first. If it cannot fit the
		// settlement reservation, preserve dispatch status, not its data.
		if len(api.JSON(result)) > 1<<20 {
			result.Content = api.Text(api.ErrResultTooLarge.Error())
			result.Structured, result.Data, result.Wire, result.Copies = nil, nil, nil, nil
			result.ProcessingError = errors.Join(result.ProcessingError, api.ErrResultTooLarge)
		}
		before.Result = result
		return before, nil
	}
	if err != nil {
		return nil, err
	}
	switch name {
	case "runtime.result":
		result := changed.(api.ResultCheck)
		if len(p.input.ResultSchema) != 0 && result.Continue == "" {
			if err := api.ValidateResult(p.input.ResultSchema, &result); err != nil {
				result.Continue = err.Error()
			}
			changed = result
		}
		if result.Continue != "" {
			if _, err := p.Record(ctx, api.Entry{Kind: "resultFeedback", Visible: true, Data: api.JSON(result.Continue)}); err != nil {
				return nil, err
			}
		}
	case "runtime.step.before":
		step := changed.(api.StepContext)
		if len(p.input.ResultSchema) != 0 {
			step.Request.System += "\nReturn the final answer as a single JSON value matching this schema (no Markdown): " + string(p.input.ResultSchema)
		}
		snap, err := p.Snapshot()
		if err != nil {
			return nil, err
		}
		branch := snap.Branch()
		start := len(branch)
		for start > 0 {
			e := branch[start-1]
			if e.Turn == p.id && e.WasKind("model.request") {
				break
			}
			start--
		}
		for _, e := range branch[start:] {
			if e.Turn == p.id && e.Kind == "resultFeedback" {
				step.Request.Messages = append(step.Request.Messages, api.Message{Role: "user", Content: api.Text(api.Decode[string](e.Data))})
				step.Sources = append(step.Sources, e.ID)
			}
		}
		changed = step
	}
	return changed, nil
}
func (p *turnPorts) CheckWriter() error {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if err := p.s.reconcileErasureLocked(); err != nil {
		return err
	}
	return p.s.checkWriterLocked()
}

func (p *turnPorts) CheckTenantBudget() error {
	p.s.mu.Lock()
	name := p.s.data.Tenant
	p.s.mu.Unlock()
	return p.c.checkBudget(name)
}

func (p *turnPorts) ResultShape() json.RawMessage { return p.input.ResultSchema }

func (p *turnPorts) Snapshot() (api.Session, error) {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if err := p.s.reconcileErasureLocked(); err != nil {
		return api.Session{}, err
	}
	snap := copySession(p.s.data)
	if err := p.s.admitErasureView(snap); err != nil {
		return api.Session{}, err
	}
	return snap, nil
}
