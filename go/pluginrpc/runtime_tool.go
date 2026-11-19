package pluginrpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

func newRuntimeWork(t api.Turn) *runtimeWork {
	return &runtimeWork{turn: t, ids: map[string]bool{}, responses: map[string]*runtimeAttempt{}, calls: map[string]api.Call{}, committed: map[string]bool{}, offered: map[string]bool{}, gating: map[string]bool{}, pending: map[string]bool{}, ran: map[string]bool{}, approved: map[string]api.ToolCheck{}, results: map[string]api.ToolResult{}, terminals: map[string]api.Entry{}, repeating: map[string]bool{}, registrations: map[string]object{}, priorInputs: map[string]json.RawMessage{}}
}

func reservedRuntimeKind(kind string) bool {
	switch kind {
	case "model", "model.request", "tool.call", "tool.open", "tool.started", "tool.result", "turn.start", "turn.end", "step.start", "step.end", "input.accepted", "input.returned", "input.withdrawn", "plugins.set", "actor.set", "actor.left", "question.open", "question.answer", "job.start", "job.end", "resultFeedback", portable.StepAfterKind:
		return true
	}
	return false
}

func definitionValue(t api.Tool) object {
	if len(t.Wire) != 0 {
		return obj(t.Wire)
	}
	return toolOut(t)
}

func (w *runtimeWork) canRepeatRegistration(name string, start api.Entry) bool {
	if w.registration == nil {
		return false
	}
	d := asObject(obj(start.Wire)["data"])
	current := w.registration(name)
	return has(d, "source") && has(d, "definition") && current != nil &&
		sameJSON(current["source"], d["source"]) && sameJSON(current["definition"], d["definition"])
}

func recordedOffer(s api.Session, c api.Call) bool {
	if c.Step == "" {
		return c.Origin != "model"
	}
	for _, e := range s.Branch() {
		if e.Kind == "model.request" && e.Step == c.Step && e.OfferedTools != nil {
			for _, name := range *e.OfferedTools {
				if name == c.Name {
					return true
				}
			}
		}
	}
	return false
}

func (w *runtimeWork) beforeTool(ctx context.Context, p object) (any, error) {
	submitted := callIn(asObject(p["call"]))
	w.mu.Lock()
	c := w.calls[submitted.ID]
	if w.ending || !w.committed[c.ID] || c.Name != submitted.Name || !sameJSON(c.Input, submitted.Input) || w.gating[c.ID] || w.ran[c.ID] || w.pending[c.ID] || w.terminals[c.ID].ID != "" {
		w.mu.Unlock()
		return nil, fault("invalid_request", "tool gate requires an unstarted committed call with original arguments")
	}
	if _, allowed := w.approved[c.ID]; allowed {
		w.mu.Unlock()
		return nil, fault("invalid_request", "tool gate already allowed this call")
	}
	answer := object{"value": p}
	def, known := w.definition(c.Name)
	reason := ""
	safe, repeating := w.repeating[c.ID]
	switch {
	case !w.offered[c.ID]:
		reason = "not offered"
	case repeating && !safe:
		reason = "interrupted call is not safe to repeat"
	case !known || !api.CanCall(def, c.Origin):
		reason = "tool unavailable for this caller"
	}
	if reason != "" {
		defer w.mu.Unlock()
		return w.refuseTool(ctx, c, answer, reason)
	}
	w.gating[c.ID] = true
	if _, err := w.record(ctx, api.Entry{Kind: "tool.call", Step: c.Step, Call: c.ID, Data: api.JSON(c)}); err != nil {
		delete(w.gating, c.ID)
		w.mu.Unlock()
		return nil, err
	}
	t := w.turn
	w.mu.Unlock()
	p["call"], p["definition"] = callOut(c), toolOut(def)
	value, err := t.IO.Hook(ctx, "runtime.tool.before", api.ToolCheck{Session: t.Session, Turn: t.ID, Call: c, Definition: def})
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.gating, c.ID)
	check, _ := value.(api.ToolCheck)
	if errors.Is(context.Cause(w.turnContext), api.ErrProcessStopped) {
		return nil, context.Canceled
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if errors.Is(err, api.ErrQuestionOpen) || (err == nil && check.Open) {
		if err := w.leavePending(ctx, c); err != nil {
			return nil, err
		}
		answer["pending"] = "waiting for an answer"
		return answer, nil
	}
	if err != nil {
		check.Refused = err.Error()
	}
	if check.Refused != "" {
		return w.refuseTool(ctx, c, answer, check.Refused)
	}
	check.Call.ID, check.Call.Name, check.Call.Actor, check.Call.Origin, check.Call.Step, check.Call.Reference = c.ID, c.Name, c.Actor, c.Origin, c.Step, c.Reference
	w.approved[c.ID] = check
	if w.registration != nil {
		w.registrations[c.ID] = w.registration(c.Name)
	}
	p["call"] = callOut(check.Call)
	return answer, nil
}

func (w *runtimeWork) refuseTool(ctx context.Context, c api.Call, answer object, reason string) (any, error) {
	result, err := w.settleTool(context.WithoutCancel(ctx), c, api.ToolResult{Status: "refused", Content: api.Text(reason)})
	if err != nil {
		return nil, err
	}
	answer["refused"], answer["result"] = reason, resultOut(result)
	return answer, nil
}

func (w *runtimeWork) leavePending(ctx context.Context, c api.Call) error {
	snap, err := w.turn.IO.Snapshot()
	if err != nil {
		return err
	}
	requests := []string{}
	var latest string
	for _, e := range snap.Branch() {
		if e.Turn != w.turn.ID || e.Call != c.ID {
			continue
		}
		switch e.Kind {
		case "tool.started":
			latest = e.ID
			requests = nil
		case "question.open":
			q := api.Decode[struct{ Question api.Question }](e.Data).Question
			if q.ID != "" && q.Defer {
				requests = append(requests, q.ID)
			}
		}
	}
	data := object{"requestIds": requests}
	if latest != "" {
		data["toolStartedId"] = latest
	}
	_, err = w.record(ctx, api.Entry{Kind: "tool.open", Call: c.ID, Step: c.Step, Data: api.JSON(data)})
	if err == nil {
		w.pending[c.ID] = true
	}
	return err
}

func (w *runtimeWork) runTool(ctx context.Context, submitted api.Call) (any, error) {
	w.mu.Lock()
	c := w.calls[submitted.ID]
	check, allowed := w.approved[c.ID]
	if w.ending || !allowed || w.ran[c.ID] || w.pending[c.ID] || w.terminals[c.ID].ID != "" {
		w.mu.Unlock()
		return nil, fault("invalid_request", "tool dispatch requires an active allowance")
	}
	def, _ := w.definition(c.Name)
	for id := range w.ran {
		active := w.calls[id]
		other, _ := w.definition(active.Name)
		if w.terminals[id].ID == "" && !w.pending[id] && (!def.Parallel || !other.Parallel) {
			w.mu.Unlock()
			return nil, fault("invalid_request", "serial tool round is in progress")
		}
	}
	// A single non-parallel call makes the whole offered round serial.
	for id := range w.committed {
		other, _ := w.definition(w.calls[id].Name)
		if w.calls[id].Step == c.Step && !other.Parallel {
			for live := range w.ran {
				if w.terminals[live].ID == "" && !w.pending[live] {
					w.mu.Unlock()
					return nil, fault("invalid_request", "serial tool round is in progress")
				}
			}
			break
		}
	}
	delete(w.approved, c.ID)
	reason := ""
	registration := w.registrations[c.ID]
	switch {
	case submitted.Name != check.Call.Name || !sameJSON(submitted.Input, check.Call.Input):
		reason = "submitted call differs from allowance"
	case w.registration != nil && !sameJSON(registration, w.registration(c.Name)):
		w.mu.Unlock()
		return nil, fault("invalid_request", "tool registration changed; obtain a fresh allowance")
	case w.priorInputs[c.ID] != nil && !sameJSON(w.priorInputs[c.ID], check.Call.Input):
		reason = "interrupted call's final arguments differ from its previous dispatch"
	case w.registration != nil && registration == nil:
		reason = "tool registration is unavailable"
	case !w.authorize(w.turn.Session, w.turn.Actor, "tools"):
		reason = "tool authority refused"
	}
	if reason == "" && check.Validate != nil {
		if err := check.Validate(check.Call); err != nil {
			reason = err.Error()
		}
	}
	if reason != "" {
		out, err := w.settleTool(context.WithoutCancel(ctx), c, api.ToolResult{Status: "refused", Content: api.Text(reason)})
		w.mu.Unlock()
		return resultOut(out), err
	}
	if err := ctx.Err(); err != nil {
		w.mu.Unlock()
		return nil, err
	}
	c = check.Call
	repeat := def.SafeRepeat && w.turn.CanRepeat
	data := object{"definition": definitionValue(def)}
	if registration != nil {
		data["definition"], data["source"] = registration["definition"], registration["source"]
	}
	e := api.Entry{Kind: "tool.started", Step: c.Step, Call: c.ID, Data: api.JSON(c), Wire: mustJSON(object{"data": data}), SafeToRepeat: &repeat, OpenWorld: &def.External}
	if !fitsHistoryEntry(w.turn, e) {
		w.mu.Unlock()
		return nil, fault("result_too_large", "tool checkpoint cannot fit history")
	}
	if _, err := w.record(ctx, e); err != nil {
		w.mu.Unlock()
		return nil, err
	}
	w.ran[c.ID] = true
	w.mu.Unlock()
	t := w.turn
	result := t.IO.RunTool(api.WithExecution(api.AsActor(ctx, t.Actor), api.Execution{Session: t.Session, Turn: t.ID, Call: c}), c)
	w.mu.Lock()
	defer w.mu.Unlock()
	if errors.Is(context.Cause(w.turnContext), api.ErrProcessStopped) {
		return nil, context.Canceled
	}
	ctx = context.WithoutCancel(ctx)
	if result.Status == "open" {
		if err := w.leavePending(ctx, c); err != nil {
			return nil, err
		}
		return object{"callId": c.ID, "pending": "waiting for an answer"}, nil
	}
	out, err := w.settleTool(ctx, c, result)
	return resultOut(out), errors.Join(err, result.ProcessingError)
}

// settleTool is the sole terminal transition. Hook outputs may refine the
// payload, but cannot rewrite whether execution was observed or authorized.
func (w *runtimeWork) settleTool(ctx context.Context, c api.Call, r api.ToolResult) (api.ToolResult, error) {
	if w.terminals[c.ID].ID != "" {
		return w.results[c.ID], nil
	}
	if _, repeating := w.repeating[c.ID]; repeating && (!w.ran[c.ID] || r.Status == "refused" || r.NotDispatched) {
		r = unknownInterruptedCall(c)
	}
	r.Call, r.Name, r.Reference = c.ID, c.Name, c.Reference
	value, err := w.turn.IO.Hook(api.WithExecution(ctx, api.Execution{Session: w.turn.Session, Turn: w.turn.ID, Call: c}), "runtime.tool.after", api.AfterTool{Call: c, Result: r})
	if err == nil {
		if checked, ok := value.(api.AfterTool); ok {
			r.Content, r.Structured = checked.Result.Content, checked.Result.Structured
		}
	} else {
		w.turn.IO.Emit(ctx, api.Event{Kind: "plugin.problem", Call: c.ID, Data: api.JSON(err.Error())})
	}
	draft := func() api.Entry {
		return api.Entry{Kind: "tool.result", Step: c.Step, Call: c.ID, Content: r.Content, Visible: true, Data: api.JSON(r), Copies: r.Copies}
	}
	if !fitsHistoryEntry(w.turn, draft()) {
		r.Content, r.Structured, r.Wire, r.Copies = api.Text("Tool result too large to retain."), nil, nil, nil
		w.turn.IO.Emit(ctx, api.Event{Kind: "plugin.problem", Call: c.ID, Data: api.JSON("result_too_large")})
	}
	e, err := w.record(ctx, draft())
	if err != nil {
		return r, err
	}
	w.results[c.ID], w.terminals[c.ID] = r, e
	delete(w.approved, c.ID)
	delete(w.pending, c.ID)
	return r, nil
}

func (w *runtimeWork) recordResult(id, step string, v object) (any, error) {
	saved := w.terminals[id]
	d, m := asObject(v["data"]), asObject(v["message"])
	if saved.ID == "" || step != saved.Step || str(d, "status") == "notStarted" {
		return nil, fault("invalid_request", "terminal result is host-owned")
	}
	x := portable.Entry(saved)
	actual := asObject(x["data"])
	for k := range actual {
		if strings.HasPrefix(k, "go.") {
			delete(actual, k)
		}
	}
	if !sameJSON(m, x["message"]) || !sameJSON(d, actual) {
		return nil, fault("invalid_request", "conflicting tool result")
	}
	return x, nil
}
