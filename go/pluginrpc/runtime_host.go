package pluginrpc

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"strings"
	"sync"
)

type remoteRuntime struct{ *remote }

func (r *remoteRuntime) Declaration() api.RuntimeDeclaration {
	d := r.reg.Runtime.Supports
	return api.RuntimeDeclaration{Durable: d.ContinuesAfterRestart, Steering: d.InputDuringTurn, WaitingThroughRestart: d.WaitingThroughRestart}
}

// Runtime work is locked to the selected turn/actor/model. The mutex guards
// the approval and recording boundaries, not Provider or tool execution.
type runtimeWork struct {
	turn                                                                     api.Turn
	authorize                                                                func(string, string, string) bool
	discard                                                                  func(context.Context) error
	turnContext                                                              context.Context
	mu                                                                       sync.Mutex
	start, end                                                               api.Entry
	ids                                                                      map[string]bool
	prepared, active                                                         *runtimeAttempt
	responses                                                                map[string]*runtimeAttempt
	replacement                                                              object
	replay                                                                   api.Entry
	usage                                                                    api.Usage
	attempts                                                                 int
	limit, stepRefusal                                                       string
	compacted, compactPending, ending, started, resultChecked, resultRefused bool
	steering                                                                 bool
	registration                                                             func(string) object
	registrations                                                            map[string]object
	calls                                                                    map[string]api.Call
	committed, offered, gating, pending, ran                                 map[string]bool
	approved                                                                 map[string]api.ToolCheck
	results                                                                  map[string]api.ToolResult
	terminals                                                                map[string]api.Entry
	priorInputs                                                              map[string]json.RawMessage
	repeating                                                                map[string]bool
}

func (r *remoteRuntime) Run(ctx context.Context, t api.Turn) api.Outcome {
	return runRuntimeHost(ctx, t, r.host.a, r.Declaration(), func(ctx context.Context, _ *runtimeWork, method string, params object) (object, error) {
		var result object
		err := r.callTrackingTools(ctx, method, params, &result, true)
		return result, err
	})
}

func runRuntimeHost(ctx context.Context, t api.Turn, host api.API, declaration api.RuntimeDeclaration, invoke func(context.Context, *runtimeWork, string, object) (object, error)) api.Outcome {
	fail := func(err error) api.Outcome {
		o := api.Outcome{Status: "failed", Error: err.Error()}
		if ctx.Err() != nil && !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			o.Status = "cancelled"
		}
		return o
	}
	w := newRuntimeWork(t)
	w.turnContext, w.authorize = ctx, host.Authorize
	w.steering = declaration.Steering
	if port, ok := t.IO.(interface {
		ToolRegistration(string) (string, string, api.Tool, bool)
	}); ok {
		w.registration = func(name string) object {
			plugin, source, def, found := port.ToolRegistration(name)
			if !found {
				return nil
			}
			return object{"source": object{"plugin": plugin, "toolSource": source}, "definition": definitionValue(def)}
		}
	}
	model := t.Access.Model()
	if model.Stateful {
		w.discard = func(ctx context.Context) error {
			return discardRuntimeProvider(ctx, host, t.Access, t.Session)
		}
	}
	snap, err := t.IO.Snapshot()
	if err != nil {
		return fail(err)
	}
	for _, e := range snap.Branch() {
		if e.Turn == t.ID && e.Kind == "turn.start" {
			w.start = e
		}
	}
	// The Harness guarantees a start record even if the plugin dies before
	// sending any callbacks. A Runtime's own turnStart write joins this entry.
	if w.start.ID == "" {
		w.start, err = t.IO.Record(ctx, api.Entry{Kind: "turn.start", Data: api.JSON(api.TurnStart{StartedBy: t.StartedBy, Model: model, Input: t.Input, Settings: t.Settings, Tools: t.Tools, System: t.System, Context: t.Context, Calls: t.Reopen})})
		if err != nil {
			return fail(err)
		}
		t.IO.Emit(ctx, api.Event{Kind: "turn.start"})
	}
	params := object{"turn": object{
		"sessionId": t.Session, "turnId": t.ID, "startedBy": t.StartedBy, "model": modelOut(model),
		"modelSupports": object{"keepsState": model.Stateful, "runsTools": model.RunsTools, "safeToRepeat": model.SafeToRepeatRequests},
		"settings":      object{"maxSteps": t.Settings.MaxSteps, "maxOutput": t.Settings.MaxOutput, "reasoning": t.Settings.Thinking},
	}}
	for _, entry := range snap.Branch() {
		if entry.Turn == t.ID && entry.Kind == "input" {
			if shape := api.Decode[api.Input](entry.Data).ResultSchema; len(shape) != 0 {
				asObjectTurn := params["turn"].(object)
				asObjectTurn["resultShape"] = shape
			}
			break
		}
	}
	method := "runtime/runTurn"
	if t.Resume {
		method = "runtime/resumeTurn"
		interrupted, err := w.restoreInterrupted(ctx, snap, declaration.Durable)
		if err != nil {
			out := fail(err)
			w.applyOutcome(&out)
			if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
				if err := w.settleOutstanding(context.WithoutCancel(ctx), out); err != nil {
					return fail(err)
				}
				if err := w.finish(context.WithoutCancel(ctx), out); err != nil {
					return fail(err)
				}
			}
			return out
		}
		params["interrupted"] = interrupted
		t.IO.Emit(ctx, api.Event{Kind: "turn.resumed"})
	} else if t.Continuing {
		method = "runtime/continueOpenCalls"
		calls := []object{}
		for _, c := range t.Reopen {
			c.Actor = t.Actor
			if c.Origin == "" {
				c.Origin = "model"
			}
			w.calls[c.ID], w.committed[c.ID] = c, true
			w.offered[c.ID] = recordedOffer(snap, c)
			calls = append(calls, pendingCallOut(c, false, false))
		}
		params["calls"] = calls
	}
	ctx = withWork(ctx, work{session: t.Session, actor: t.Actor, runtime: w})
	result, err := invoke(ctx, w, method, params)
	out := outcomeIn(result)
	if err != nil {
		out = fail(err)
	} else {
		switch out.Status {
		case "completed", "failed", "cancelled", "limit":
		default:
			err = fault("internal", "Runtime returned an invalid outcome")
			out = fail(err)
		}
	}
	if errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
		return out
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err == nil && (!w.boundary() || w.resultRefused) && out.Status == "completed" {
		out = fail(fault("invalid_request", "Runtime ended outside a settlement boundary"))
	}
	w.applyOutcome(&out)
	if w.end.ID == "" {
		if err := w.abortReplay(context.Background()); err != nil {
			return fail(err)
		}
		if w.active != nil && w.active.intent.ID != "" && w.active.response.ID == "" && !w.active.after {
			if _, err := w.abortAttempt(context.Background(), w.active.intent); err != nil {
				return fail(err)
			}
		}
		if err := w.settleOutstanding(context.Background(), out); err != nil {
			return fail(err)
		}
		if err := w.finish(context.Background(), out); err != nil {
			return fail(err)
		}
	}
	out = api.Decode[api.Outcome](w.end.Data)
	t.IO.Emit(context.Background(), api.Event{Kind: "turn.end", Data: api.JSON(out)})
	return out
}

func discardRuntimeProvider(ctx context.Context, host api.API, access api.ModelAccess, session string) error {
	var provider any
	switch a := access.(type) {
	case *localAccess:
		provider = a.provider
	case *remoteAccess:
		provider = a.p
	default:
		var err error
		provider, err = host.Get("provider." + access.Model().Provider)
		if err != nil {
			return err
		}
	}
	discard, ok := provider.(interface {
		Discard(context.Context, string) error
	})
	if !ok {
		return errors.New("stateful Provider does not support discard")
	}
	return discard.Discard(ctx, session)
}

type interruptedCall struct {
	call                     api.Call
	start                    api.Entry
	started, repeat, pending bool
}

func (w *runtimeWork) settleOutstanding(ctx context.Context, out api.Outcome) error {
	snap, err := w.turn.IO.Snapshot()
	if err != nil {
		return err
	}
	open := map[string]bool{}
	for _, c := range out.Open {
		open[c.ID] = true
	}
	for _, pending := range interruptedCalls(snap, w.turn) {
		c := w.calls[pending.call.ID]
		if c.ID == "" {
			c = pending.call
			c.Actor = w.turn.Actor
		}
		if open[c.ID] {
			continue
		}
		res, known := w.results[c.ID]
		if !known || res.Status == "open" {
			res = api.ToolResult{Status: "not_started", Content: api.Text("Runtime stopped before the call ran.")}
			if pending.started {
				res = unknownInterruptedCall(c)
			} else if out.Status == "cancelled" {
				res.Status, res.Content = "cancelled", api.Text("Turn cancelled before the call ran.")
			}
		}
		res.Call, res.Name, res.Reference = c.ID, c.Name, c.Reference
		if _, err := w.settleTool(ctx, c, res); err != nil {
			return err
		}
	}
	return nil
}

func interruptedCalls(s api.Session, t api.Turn) []interruptedCall {
	order := []string{}
	calls := map[string]api.Call{}
	starts := map[string]api.Entry{}
	started, repeat, settled, pending := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	add := func(c api.Call) {
		if c.ID == "" {
			return
		}
		if c.Actor == "" {
			c.Actor = t.Actor
		}
		if c.Origin == "" && c.Step != "" {
			c.Origin = "model"
		}
		if _, ok := calls[c.ID]; !ok {
			order = append(order, c.ID)
		}
		calls[c.ID] = c
	}
	for _, c := range t.Reopen {
		add(c)
	}
	for _, e := range s.Entries {
		if e.WasKind("tool.result") {
			settled[e.Call] = true
		}
	}
	for _, e := range s.Branch() {
		if e.Turn == t.ID {
			switch e.Kind {
			case "model":
				for _, p := range e.Content {
					if p.Call != nil {
						c := *p.Call
						c.Step = e.Step
						add(c)
					}
				}
			case "tool.open":
				pending[e.Call] = true
			case "tool.call", "tool.started":
				c := api.Decode[api.Call](e.Data)
				c.Step = e.Step
				if _, known := calls[c.ID]; !known {
					add(c)
				}
				if e.Kind == "tool.started" {
					started[e.Call] = true
					starts[e.Call] = e
					repeat[e.Call] = e.SafeToRepeat != nil && *e.SafeToRepeat
				}
			}
		}
		if e.WasKind("tool.result") {
			settled[e.Call] = true
		}
		if e.Turn == t.ID && e.IsErased() && e.WasKind("tool.started") {
			started[e.Call], repeat[e.Call] = true, false
		}
	}
	out := []interruptedCall{}
	for _, id := range order {
		if !settled[id] {
			out = append(out, interruptedCall{call: calls[id], start: starts[id], started: started[id], repeat: repeat[id], pending: pending[id]})
		}
	}
	return out
}

func (r *remote) runtimeCallback(ctx context.Context, method string, v object) (any, error) {
	parent, ok := r.peer.requestParent(ctx, mustJSON(v["parentRequestId"]))
	if !ok {
		return nil, fault("invalid_request", "Runtime turn is not active")
	}
	w, _ := parent.Value(workKey{}).(work)
	rt := w.runtime
	if rt == nil {
		return nil, fault("invalid_request", "callback parent is not a Runtime turn")
	}
	return rt.callback(ctx, parent, RequestID(ctx), r.peer, method, v)
}

func (rt *runtimeWork) callback(ctx, parent context.Context, id any, peer *Peer, method string, v object) (any, error) {
	if (has(v, "sessionId") && str(v, "sessionId") != rt.turn.Session) || (has(v, "turnId") && str(v, "turnId") != rt.turn.ID) {
		return nil, fault("invalid_request", "callback session or turn differs from parent")
	}
	if !rt.authorize(rt.turn.Session, rt.turn.Actor, "watch") {
		return nil, fault("invalid_request", "Runtime turn actor cannot watch the session")
	}
	rt.mu.Lock()
	ended := rt.end.ID != "" || rt.ending
	rt.mu.Unlock()
	if ended {
		return nil, fault("invalid_request", "Runtime turn has ended")
	}
	if errors.Is(context.Cause(parent), api.ErrProcessStopped) {
		return nil, context.Canceled
	}
	// Cancellation stops outside work. It must not prevent the Runtime
	// from settling calls and observing turn.end before it answers.
	base := parent
	hook := str(v, "hook")
	if method == "host/runtime/record" || (method == "host/runtime/hook" && (hook == "turn.end" || hook == "tool.after" || hook == "step.after")) {
		base = context.WithoutCancel(parent)
	}
	linked, cancel := context.WithCancel(base)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	if err := linked.Err(); err != nil {
		return nil, err
	}
	if method == "host/runtime/report" {
		rt.report(linked, v)
		return nil, nil
	}
	return rt.handle(linked, id, peer, method, v)
}

func (w *runtimeWork) handle(ctx context.Context, id any, p *Peer, method string, v object) (any, error) {
	t := w.turn
	switch method {
	case "host/history":
		snap, err := t.IO.Snapshot()
		if err != nil {
			return nil, err
		}
		return HistoryPage(snap, v)
	case "host/runtime/newId":
		w.mu.Lock()
		defer w.mu.Unlock()
		id := api.ID()
		w.ids[id] = true
		return object{"id": id}, nil
	case "host/runtime/prepareStep":
		return w.prepare(ctx, str(v, "stepId"), usageIn(asObject(v["usage"])))
	case "host/runtime/model":
		return w.model(ctx, id, p, str(v, "stepId"), asObject(v["request"]))
	case "host/runtime/hook":
		return w.hook(ctx, str(v, "hook"), asObject(v["payload"]))
	case "host/runtime/definition":
		if tool, ok := w.definition(str(v, "toolName")); ok {
			return toolOut(tool), nil
		}
		return nil, nil
	case "host/runtime/runToolCall":
		return w.runTool(ctx, callIn(asObject(v["call"])))
	case "host/runtime/record":
		return w.recordWire(ctx, asObject(v["entry"]))
	case "host/runtime/takeSteering":
		w.mu.Lock()
		defer w.mu.Unlock()
		if !w.steering {
			return nil, fault("not_supported", "steering is unavailable")
		}
		final := boolean(v, "final")
		if !w.boundary() {
			if final {
				return nil, fault("invalid_request", "final steering check is out of phase")
			}
			return object{"entries": []object{}}, nil
		}
		ports, ok := t.IO.(interface {
			TakeSteeringBoundary(context.Context, bool) ([]api.Entry, error)
		})
		if !ok {
			return nil, fault("not_supported", "steering is unavailable")
		}
		entries, err := ports.TakeSteeringBoundary(ctx, final)
		out := []object{}
		for _, e := range entries {
			out = append(out, portable.Entry(e))
		}
		return object{"entries": out}, err
	case "host/runtime/hasSteering":
		return object{"waiting": t.IO.(interface{ HasSteering() bool }).HasSteering()}, nil
	}
	return nil, unknownMethod(method)
}

func (w *runtimeWork) definition(name string) (api.Tool, bool) {
	for _, t := range w.turn.Tools {
		if t.Name == name {
			return t, true
		}
	}
	return api.Tool{}, false
}

func (w *runtimeWork) normalizeCallsLocked(step string, res *api.Response) {
	seen := map[string]bool{}
	if s, err := w.turn.IO.Snapshot(); err == nil {
		for _, e := range s.Entries {
			if e.Call != "" {
				seen[e.Call] = true
			}
			if e.Kind == "model" {
				for _, p := range e.Content {
					if p.Call != nil {
						seen[p.Call.ID] = true
					}
				}
			}
		}
	}
	for i, p := range res.Content {
		if p.Call == nil {
			continue
		}
		c := *p.Call
		if c.ID == "" || seen[c.ID] {
			c.Reference, c.ID = c.ID, api.ID()
		}
		if c.Origin == "" {
			c.Origin = "model"
		}
		c.Actor, c.Step = w.turn.Actor, step
		w.calls[c.ID], seen[c.ID] = c, true
		res.Content[i].Call = &c
	}
}

func (w *runtimeWork) report(ctx context.Context, v object) {
	w.mu.Lock()
	ended := w.end.ID != ""
	w.mu.Unlock()
	if ended {
		return
	}
	kind := str(v, "type")
	// Provider streams and committed records are the authoritative host
	// events. Do not deliver another copy from a Runtime relaying them.
	switch kind {
	case "model.delta", "model.output", "model.stream.end", "step.start", "step.end", "tool.requested", "tool.started", "tool.progress", "tool.end", "turn.start", "turn.end", "turn.resumed", "history.added":
		return
	}
	if strings.Contains(kind, ".") && !reservedRuntimeKind(kind) {
		w.turn.IO.Emit(ctx, api.Event{Kind: kind, Step: str(v, "stepId"), Call: str(v, "toolCallId"), Data: mustJSON(v["data"])})
	}
}

func (w *runtimeWork) recordWire(ctx context.Context, v object) (any, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ending || w.end.ID != "" {
		return nil, fault("invalid_request", "Runtime turn has ended")
	}
	kind := str(v, "kind")
	v["id"] = "draft"
	e, err := portable.ReadEntry(mustJSON(v))
	if err != nil {
		return nil, fault("invalid_request", err.Error())
	}
	switch kind {
	case "response":
		return w.storeResponse(ctx, e, asObject(v["message"]))
	case "toolResult":
		return w.recordResult(e.Call, e.Step, v)
	default:
		if !strings.Contains(kind, ".") || strings.HasPrefix(kind, "go.") || e.Kind != kind || reservedRuntimeKind(kind) {
			return nil, fault("invalid_request", "entry kind belongs to the host")
		}
		e.Wire, e.Copies, e.Visible = nil, nil, false
		recorded, err := w.record(ctx, e)
		return portable.Entry(recorded), err
	}
}

// The binding returns open call IDs. The native question scheduler also
// needs the original arguments and actor to start the late-call turn.
func (w *runtimeWork) hydrateOpen(o *api.Outcome) {
	if len(o.Open) == 0 {
		return
	}
	snap, err := w.turn.IO.Snapshot()
	if err != nil {
		return
	}
	for i, c := range o.Open {
		if live, ok := w.calls[c.ID]; ok {
			o.Open[i] = live
			continue
		}
		for _, open := range api.OpenCalls(snap) {
			if open.ID == c.ID {
				o.Open[i] = open
				break
			}
		}
	}
}

func (w *runtimeWork) honorCancel(o *api.Outcome) {
	if o.Status != "completed" && w.turnContext != nil && w.turnContext.Err() != nil && !errors.Is(context.Cause(w.turnContext), api.ErrProcessStopped) {
		o.Status, o.Error = "cancelled", ""
	}
}

func (w *runtimeWork) applyOutcome(o *api.Outcome) {
	if w.turnContext != nil && w.turnContext.Err() != nil && !errors.Is(context.Cause(w.turnContext), api.ErrProcessStopped) {
		o.Status, o.Error = "cancelled", ""
	} else if w.limit != "" {
		o.Status, o.Error = "limit", w.limit+" limit"
	} else if w.stepRefusal != "" {
		o.Status, o.Error = "failed", w.stepRefusal
	}
	o.Usage, o.Steps = w.usage, w.attempts
	if snap, err := w.turn.IO.Snapshot(); err == nil {
		auxiliary := map[string]bool{}
		for _, e := range snap.Branch() {
			if e.Turn != w.turn.ID {
				continue
			}
			if e.Kind == "model.request" && boolean(asObject(obj(e.Wire)["data"]), "auxiliary") {
				auxiliary[e.Step] = true
			}
			if e.Kind == "model" && auxiliary[e.Step] {
				o.Usage.Add(api.Decode[struct{ Usage api.Usage }](e.Data).Usage)
			}
		}
	}
	o.Open = nil
	if o.Status != "cancelled" {
		for id := range w.pending {
			if w.pending[id] {
				o.Open = append(o.Open, w.calls[id])
			}
		}
	}
}

func (w *runtimeWork) finish(ctx context.Context, o api.Outcome) error {
	var sources []string
	if snap, err := w.turn.IO.Snapshot(); err == nil {
		for _, e := range snap.Branch() {
			if e.Turn == w.turn.ID && (e.Kind == "model" || e.Kind == "tool.result") {
				sources = append(sources, e.ID)
			}
		}
	}
	entry, err := w.record(ctx, api.Entry{Kind: "turn.end", Data: api.JSON(o), Copies: sources})
	if err == nil {
		w.end = entry
	}
	return err
}

func unknownInterruptedCall(c api.Call) api.ToolResult {
	return api.ToolResult{Call: c.ID, Name: c.Name, Reference: c.Reference, Status: "unknown", Content: api.Text("Call did not finish; its outcome is unknown. Check outside state before relying on it.")}
}

func (w *runtimeWork) record(ctx context.Context, e api.Entry) (api.Entry, error) {
	e.ID = "" // IDs are always allocated by the Harness.

	stored, err := w.turn.IO.Record(ctx, e)
	if err != nil {
		return stored, err
	}
	event := api.Event{Step: stored.Step, Call: stored.Call, Data: stored.Data}
	switch stored.Kind {
	case "tool.call":
		event.Kind = "tool.requested"
	case "tool.started":
		event.Kind = "tool.started"
	case "tool.result":
		event.Kind = "tool.end"
	}
	if event.Kind != "" {
		w.turn.IO.Emit(ctx, event)
	}
	return stored, nil
}
