package pluginrpc

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/turnrun"
)

type runtimeAttempt struct {
	step                               string
	request, effective, answer         object
	sources                            []string
	intent, response                   api.Entry
	stepDecision                       portable.StepAfter
	after, failureAsked, retry, replay bool
}

func limitError(name string) *RPCError {
	e := fault("turn_limit", name+" limit")
	e.Data.Limit = name
	return e
}

// checkLimits is called with the turn locked. Check again at the grant, since
// transforms and the intent commit can take time and affect the tenant budget.
func (w *runtimeWork) checkLimits(ctx context.Context, beforeIntent bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if w.limit != "" {
		return limitError(w.limit)
	}
	if beforeIntent && w.turn.Settings.MaxSteps > 0 && w.attempts >= w.turn.Settings.MaxSteps {
		w.limit = "steps"
		return limitError(w.limit)
	}
	return w.checkBudget()
}

func (w *runtimeWork) checkBudget() error {
	if b, ok := w.turn.IO.(interface{ CheckTenantBudget() error }); ok {
		if err := b.CheckTenantBudget(); err != nil {
			if errors.Is(err, api.ErrTenantTokens) {
				w.limit = "tenantTokens"
				return limitError(w.limit)
			}
			return err
		}
	}
	return nil
}

func (w *runtimeWork) boundary() bool {
	if w.active != nil && !w.active.after {
		return false
	}
	for id := range w.committed {
		if w.terminals[id].ID == "" && !w.pending[id] {
			return false
		}
	}
	return true
}

func (w *runtimeWork) prepare(ctx context.Context, step string, usage api.Usage) (any, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.ids[step] || w.prepared != nil || !w.boundary() || w.ending {
		return nil, fault("invalid_request", "step cannot be prepared at this boundary")
	}
	if usage.Input != w.usage.Input || usage.Output != w.usage.Output || usage.Cached != w.usage.Cached || usage.CacheWrite != w.usage.CacheWrite {
		return nil, fault("invalid_request", "step usage does not match committed responses")
	}
	if err := w.checkLimits(ctx, true); err != nil {
		return nil, err
	}
	if w.stepRefusal != "" {
		return nil, fault("invalid_request", w.stepRefusal)
	}
	if err := w.abortReplay(ctx); err != nil {
		return nil, err
	}
	t := w.turn
	tools := []api.Tool{}
	for _, d := range t.Tools {
		if api.OffersModelTool(t.Settings, d) {
			tools = append(tools, d)
		}
	}
	sc := api.StepContext{Turn: t, Step: step, Usage: w.usage, Compact: w.compactPending, DeferredCompaction: true, Request: api.Request{System: t.System, Tools: tools, Thinking: t.Settings.Thinking, MaxOutput: t.Settings.MaxOutput}}
	out, err := t.IO.Hook(ctx, "runtime.step.before", sc)
	if err != nil {
		return nil, err
	}
	sc = out.(api.StepContext)
	w.compactPending = false
	sc.Request.Messages = turnrun.ModelCallOrder(sc.Request.Messages)
	req := requestOut(sc.Request)
	if _, err := w.offer(req); err != nil {
		return nil, err
	}
	w.prepared = &runtimeAttempt{step: step, request: req, sources: sc.Sources}
	w.replacement = nil
	t.IO.Emit(ctx, api.Event{Kind: "step.start", Step: step})
	return req, nil
}

func (w *runtimeWork) offer(req object) ([]string, error) {
	names := []string{}
	for _, tool := range objects(req["tools"]) {
		name := str(tool, "name")
		def, ok := w.definition(name)
		if !ok || !api.OffersModelTool(w.turn.Settings, def) || !sameJSON(toolOut(def), tool) {
			return nil, fault("invalid_request", "request expanded or changed a tool definition")
		}
		names = append(names, name)
	}
	return names, nil
}

func (w *runtimeWork) model(ctx context.Context, id any, p *Peer, step string, req object) (any, error) {
	w.mu.Lock()
	if !w.ids[step] || !w.boundary() || w.ending || w.stepRefusal != "" {
		w.mu.Unlock()
		return nil, fault("invalid_request", "model attempt is out of phase")
	}
	var a *runtimeAttempt
	switch {
	case w.prepared != nil && w.prepared.step == step && sameJSON(w.prepared.request, req):
		a = w.prepared
	case w.prepared == nil && w.replacement != nil && sameJSON(w.replacement, req):
		a = &runtimeAttempt{step: step, request: req, sources: w.active.sources}
	case w.prepared == nil && w.replay.ID != "" && sameJSON(modelIntentRequest(w.replay), req):
		a = &runtimeAttempt{step: step, request: req, sources: w.replay.Copies, replay: true}
	default:
		w.mu.Unlock()
		return nil, fault("invalid_request", "model request was not prepared or authorized")
	}
	if err := w.checkLimits(ctx, true); err != nil {
		w.mu.Unlock()
		return nil, err
	}
	delete(w.ids, step)
	w.prepared, w.replacement, w.active = nil, nil, a
	w.resultChecked, w.resultRefused = false, false
	w.mu.Unlock()
	t := w.turn
	ctx = api.WithExecution(api.AsActor(ctx, t.Actor), api.Execution{Session: t.Session, Turn: t.ID})
	commit := func(final object) error {
		w.mu.Lock()
		defer w.mu.Unlock()
		if err := w.checkLimits(ctx, true); err != nil {
			return err
		}
		names, err := w.offer(final)
		if err != nil {
			return err
		}
		if err := w.abortReplay(ctx); err != nil {
			return err
		}
		draft := turnrun.ModelRequest(step, t.Access.Model())
		draft.TracksStepAfter = true
		draft.Copies, draft.OfferedTools = a.sources, &names
		draft.Wire = mustJSON(object{"data": object{"request": final}})
		if !fitsHistoryEntry(t, draft) {
			unsafe := false
			draft.SafeToRepeat, draft.Wire = &unsafe, nil
			if !fitsHistoryEntry(t, draft) {
				return fault("result_too_large", "model intent cannot fit history")
			}
		}
		a.intent, err = w.record(ctx, draft)
		if err != nil {
			return err
		}
		a.effective = final
		w.attempts++
		if err = w.checkLimits(ctx, false); Code(err) == "turn_limit" || errors.Is(err, context.Canceled) {
			if _, saveErr := w.abortAttempt(context.WithoutCancel(ctx), a.intent); saveErr != nil {
				return saveErr
			}
			a.after = true
			return err
		} else if err != nil {
			return err
		}
		if writer, ok := t.IO.(interface{ CheckWriter() error }); ok {
			return writer.CheckWriter()
		}
		return nil
	}
	ctx = api.WithFinalModelDispatch(ctx, api.FinalModelDispatch{Replay: a.replay, Commit: func(_ context.Context, r api.Request) error { return commit(requestValue(r)) }})
	if _, hooked := t.Access.(api.HookedModelAccess); !hooked {
		if err := commit(req); err != nil {
			return nil, err
		}
	}
	res, err := t.Access.Generate(ctx, requestIn(req), func(part api.Part) {
		t.IO.Emit(ctx, api.Event{Kind: "model.delta", Step: step, Data: api.JSON(part)})
		if p != nil && (part.Type == "text" || part.Type == "reasoning" || part.Type == "toolInput") {
			_ = p.Send("host/runtime/modelEvent", object{"parentRequestId": id, "event": object{"type": part.Type, "delta": part.Text}})
		}
	})
	w.mu.Lock()
	defer w.mu.Unlock()
	if Code(err) == "turn_limit" || Code(err) == "lost" || a.intent.ID == "" {
		a.after = true
		if err == nil {
			err = fault("invalid_request", "model was not admitted")
		}
		return nil, err
	}
	if err != nil {
		res.Stop = "failed"
	}
	if res.Stop == "output_limit" || res.Stop == "failed" || res.Stop == "aborted" || res.Stop == "refused" {
		res.Content = stripCalls(res.Content)
	}
	// Keep the Provider's raw response separate from the canonical host answer.
	w.normalizeCallsLocked(step, &res)
	msg := responseOut(res)
	if err != nil {
		msg["error"] = errorOut(err)
	}
	if !fitsHistoryEntry(t, responseDraft(step, msg)) {
		msg = responseOut(api.Response{Stop: "failed", Usage: res.Usage})
		msg["error"] = object{"kind": "other", "message": "result_too_large: model response exceeds history page"}
	}
	a.answer = msg
	t.IO.Emit(ctx, api.Event{Kind: "model.stream.end", Step: step, Data: api.JSON(res.Stop)})
	return msg, nil
}

func stripCalls(c api.Content) api.Content {
	var result api.Content
	for _, p := range c {
		if p.Call == nil {
			result = append(result, p)
		}
	}
	return result
}

func responseDraft(step string, msg object) api.Entry {
	e, _ := portable.ReadEntry(mustJSON(object{"id": "draft", "kind": "response", "stepId": step, "message": msg, "modelVisible": true}))
	return e
}

func (w *runtimeWork) abortAttempt(ctx context.Context, intent api.Entry) (api.Entry, error) {
	e := responseDraft(intent.Step, object{"role": "assistant", "stop": "aborted", "content": []any{}})
	e.Visible, e.Copies = false, []string{intent.ID}
	e.Wire = mustJSON(object{"data": object{"recovery": true}, "message": object{"role": "assistant", "stop": "aborted", "content": []any{}}})
	return w.record(ctx, e)
}

func (w *runtimeWork) abortReplay(ctx context.Context) error {
	if w.replay.ID == "" {
		return nil
	}
	_, err := w.abortAttempt(ctx, w.replay)
	if err == nil {
		w.replay = api.Entry{}
	}
	return err
}

func modelIntentRequest(e api.Entry) object {
	return asObject(asObject(obj(e.Wire)["data"])["request"])
}

func (w *runtimeWork) recoverAttempts(ctx context.Context, s api.Session, durable bool) error {
	settled, auxiliarySteps := map[string]bool{}, map[string]bool{}
	legacy := map[string]bool{}
	branch := s.Branch()
	for _, e := range branch {
		if e.Turn != w.turn.ID {
			continue
		}
		if e.Kind == "model.request" && boolean(asObject(obj(e.Wire)["data"]), "auxiliary") {
			auxiliarySteps[e.Step] = true
		}
		if e.WasKind("model") {
			settled[e.Step] = true
			if !e.IsErased() && !auxiliarySteps[e.Step] {
				w.usage.Add(api.Decode[struct{ Usage api.Usage }](e.Data).Usage)
				legacy[e.Step] = true
			}
		}
	}
	for i := len(branch) - 1; i >= 0; i-- {
		e := branch[i]
		if e.Turn != w.turn.ID || !e.WasKind("model.request") {
			continue
		}
		delete(legacy, e.Step)
		names := asObject(obj(e.Wire)["data"])
		auxiliary := boolean(names, "auxiliary") || str(names, "purpose") == "summary"
		if !auxiliary {
			w.attempts++
		}
		if settled[e.Step] {
			continue
		}
		m := api.Decode[api.Model](e.Data)
		current := w.turn.Access.Model()
		// Only the latest unmatched step is eligible for exact replay.
		if durable && w.replay.ID == "" && !auxiliary && !e.IsErased() && e.SafeToRepeat != nil && *e.SafeToRepeat && (current.SafeToRepeatRequests || !current.Stateful && !current.RunsTools) &&
			m.Provider == current.Provider && strings.TrimPrefix(m.ID, m.Provider+"/") == strings.TrimPrefix(current.ID, current.Provider+"/") && len(modelIntentRequest(e)) > 0 {
			w.replay = e
			durable = false
		} else if _, err := w.abortAttempt(ctx, e); err != nil {
			return err
		}
	}
	// Older portable logs may have a response without an intent.
	w.attempts += len(legacy)
	return nil
}

func (w *runtimeWork) storeResponse(ctx context.Context, e api.Entry, msg object) (any, error) {
	if old, ok := w.responses[e.Step]; ok {
		if !sameJSON(old.answer, msg) {
			return nil, fault("invalid_request", "conflicting response")
		}
		return portable.Entry(old.response), nil
	}
	a := w.active
	if a == nil || a.step != e.Step || a.answer == nil || !sameJSON(a.answer, msg) {
		return nil, fault("invalid_request", "response does not match an answered attempt")
	}
	e = responseDraft(e.Step, a.answer)
	e.Copies = []string{a.intent.ID}
	saved, err := w.record(ctx, e)
	if err != nil {
		return nil, err
	}
	a.response = saved
	w.responses[e.Step] = a
	w.usage.Add(responseIn(a.answer).Usage)
	names := map[string]bool{}
	if a.intent.OfferedTools != nil {
		for _, n := range *a.intent.OfferedTools {
			names[n] = true
		}
	}
	for _, part := range saved.Content {
		if part.Call != nil {
			c := w.calls[part.Call.ID]
			w.committed[c.ID] = true
			w.offered[c.ID] = names[c.Name]
		}
	}
	if stop := str(a.answer, "stop"); stop == "length" {
		w.limit = "output"
	}
	if w.limit == "" {
		_ = w.checkBudget()
	}
	return portable.Entry(saved), nil
}

func fitsHistoryEntry(t api.Turn, e api.Entry) bool {
	e.ID, e.Parent, e.Session, e.Turn, e.Writer, e.Actor = api.ID(), api.ID(), t.Session, t.ID, strings.Repeat("w", 128), t.Actor
	payload := mustJSON(object{"entries": []any{portable.Entry(e)}, "next": e.ID})
	return len(payload) < (4<<20)-256
}

func (w *runtimeWork) attemptFailure(ctx context.Context, p object) (any, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	a := w.active
	if a == nil || a.response.ID == "" || a.after || a.failureAsked || str(a.answer, "stop") != "failed" ||
		(!sameJSON(a.request, p["request"]) && !sameJSON(a.effective, p["request"])) || !sameJSON(a.answer["error"], p["error"]) {
		return nil, fault("invalid_request", "model.failed requires the committed failed attempt")
	}
	a.failureAsked = true
	if w.limit != "" {
		return nil, nil
	}
	sc := api.StepContext{Turn: w.turn, Step: a.step, Request: requestIn(a.request), Sources: a.sources, Usage: w.usage, DeferredCompaction: true}
	modelErr := modelError(asObject(a.answer["error"]))
	changed, err := w.turn.IO.Hook(ctx, "runtime.request.failed", api.Failure{Context: sc, Err: modelErr})
	if err != nil {
		return nil, err
	}
	f, ok := changed.(api.Failure)
	if !ok || !f.Retry {
		return nil, nil
	}
	var replacement object
	if !sameJSON(requestOut(f.Context.Request), requestOut(sc.Request)) {
		replacement = requestOut(f.Context.Request)
		if _, err := w.offer(replacement); err != nil {
			return nil, err
		}
	}
	if str(asObject(a.answer["error"]), "kind") == "contextTooLarge" {
		if replacement != nil || w.compacted {
			return nil, nil
		}
		w.compacted, w.compactPending = true, true
	}
	if w.discard != nil {
		t := w.turn
		if err := w.discard(api.WithExecution(api.AsActor(ctx, t.Actor), api.Execution{Session: t.Session, Turn: t.ID})); err != nil {
			return nil, fmt.Errorf("reset Provider: %w", err)
		}
	}
	a.retry = true
	w.replacement = replacement
	answer := object{"retry": true}
	if replacement != nil {
		answer["request"] = replacement
	}
	return answer, nil
}
