package pluginrpc

import (
	"context"
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
	"sync"
)

type modelEventKey struct{}

// runtimeClient holds only a request-scoped view. Recovery reloads it from
// the Harness, not the plugin's home or any state in the old process.
type runtimeClient struct {
	peer    *Peer
	parent  json.RawMessage
	turn    api.Turn
	model   api.Model
	mu      sync.Mutex
	view    api.Session
	entries []string
	cached  map[string]bool
	repeat  map[string]bool
	step    string
}

func (s *Server) runRuntime(ctx context.Context, method string, params object) (any, error) {
	v := asObject(params["turn"])
	m := modelIn(asObject(v["model"]))
	ms := asObject(v["modelSupports"])
	m.Stateful, m.RunsTools = boolean(ms, "keepsState"), boolean(ms, "runsTools")
	settings := asObject(v["settings"])
	t := api.Turn{Session: str(v, "sessionId"), ID: str(v, "turnId"), CanRepeat: true}
	_ = json.Unmarshal(mustJSON(v["startedBy"]), &t.StartedBy)
	t.Actor = t.StartedBy.ID
	t.Settings = api.Settings{Thinking: str(settings, "reasoning"), MaxOutput: number(settings, "maxOutput"), MaxSteps: number(settings, "maxSteps")}
	if !has(settings, "maxSteps") {
		t.Settings.MaxSteps = 20
	}
	port := &runtimeClient{peer: s.peer, parent: RequestID(ctx), model: m, view: api.Session{ID: t.Session}, entries: []string{}, cached: map[string]bool{}, repeat: map[string]bool{}}
	t.IO, t.Access = port, port
	if t.Session == "" || t.ID == "" {
		return nil, fault("invalid_request", "turn needs a session and turn id")
	}
	var calls []object
	var interruption object
	switch method {
	case "runtime/runTurn":
	case "runtime/resumeTurn":
		interruption = asObject(params["interrupted"])
		if str(interruption, "turnId") != t.ID {
			return nil, fault("invalid_request", "interrupted turn does not match turn")
		}
		t.Resume = true
		calls = objects(interruption["calls"])
	case "runtime/continueOpenCalls":
		t.Continuing = true
		calls = objects(params["calls"])
	default:
		return nil, unknownMethod(method)
	}
	if t.Resume || t.Continuing {
		if err := port.restore(ctx, t.Session); err != nil {
			return nil, err
		}
		byID := map[string]api.Call{}
		finished := map[string]bool{}
		for _, e := range port.view.Branch() {
			if e.Turn == t.ID && e.Kind == "turn.start" {
				start := api.Decode[api.TurnStart](e.Data)
				t.System, t.Context, t.Tools, t.Input = start.System, start.Context, start.Tools, start.Input
				t.Settings = start.Settings
				if e.Actor != "" {
					t.Actor = e.Actor
				}
				if t.Resume {
					t.Reopen = start.Calls
				}
			}
			if t.Input == "" && e.Kind == "input" && e.Turn == t.ID {
				t.Input = e.InputID()
			}
			switch e.Kind {
			case "model":
				for _, p := range e.Content {
					if p.Call != nil {
						c := *p.Call
						c.Step = e.Step
						byID[c.ID] = c
					}
				}
			case "tool.call", "tool.started":
				byID[e.Call] = api.Decode[api.Call](e.Data)
			case "tool.result":
				finished[e.Call] = true
			}
		}
		if t.Resume {
			last, err := resumeStep(port.view, t.ID, interruption)
			if err != nil {
				return nil, err
			}
			t.ResumedStep = last
		}
		stored := interruptedCalls(port.view, t)
		committed := map[string]interruptedCall{}
		for _, c := range stored {
			committed[c.call.ID] = c
		}
		supplied := map[string]bool{}
		for _, value := range calls {
			call := callIn(value)
			if call.ID == "" || call.Name == "" || supplied[call.ID] {
				return nil, fault("invalid_request", "invalid pending call")
			}
			supplied[call.ID] = true
			if finished[call.ID] {
				if t.Resume {
					return nil, fault("invalid_request", "interrupted call already settled")
				}
				continue
			}
			call.Actor, call.Origin = t.Actor, "model"
			if old, ok := byID[call.ID]; ok {
				if old.Origin != "" {
					call.Origin = old.Origin
				}
				call.Reference = old.Reference
				if call.Step == "" {
					call.Step = old.Step
				}
			}
			if t.Resume {
				history, known := committed[call.ID]
				started, repeat := boolean(value, "started"), boolean(value, "safeToRepeat")
				if !known || history.pending || history.started != started || started != repeat ||
					started && !history.repeat || history.call.Name != call.Name ||
					history.call.Step != str(value, "stepId") || !sameJSON(history.call.Input, call.Input) {
					return nil, fault("invalid_request", "interrupted call does not match checkpoint")
				}
				t.Interrupted = append(t.Interrupted, history.call)
				port.repeat[call.ID] = repeat
			} else {
				t.Reopen = append(t.Reopen, call)
			}
		}

	}
	port.turn = t
	out := s.Runtime.Run(ctx, t)
	return object{"outcome": outcomeKindOut(out), "result": turnResultOut(out), "entries": port.entries, "usage": usageOut(out.Usage)}, nil
}

func resumeStep(view api.Session, turn string, interrupted object) (*api.ResumedStep, error) {
	state, err := portable.LastAnsweredStep(view, turn)
	if err != nil {
		return nil, fault("invalid_request", err.Error())
	}
	if state.Response.ID == "" {
		if _, present := interrupted["lastStep"]; present {
			return nil, fault("invalid_request", "lastStep has no answered checkpoint")
		}
		return nil, nil
	}
	last := asObject(interrupted["lastStep"])
	decision, present := last["decision"]
	if str(last, "stepId") != state.Response.Step || present != state.Committed ||
		state.Committed && !sameJSON(decision, state.Decision()) {
		return nil, fault("invalid_request", "lastStep differs from the answered checkpoint")
	}
	message := asObject(portable.Entry(state.Response)["message"])
	return &api.ResumedStep{ID: state.Response.Step, Response: responseIn(message), Committed: state.Committed, Refused: state.Refused}, nil
}

func (p *runtimeClient) call(ctx context.Context, method string, params object, out any) error {
	params["parentRequestId"] = p.parent
	return p.peer.Call(ctx, "host/runtime/"+method, params, out)
}
func (p *runtimeClient) restore(ctx context.Context, session string) error {
	params := object{"sessionId": session, "parentRequestId": p.parent}
	for {
		var page object
		if err := p.peer.Call(ctx, "host/history", params, &page); err != nil {
			return err
		}
		for _, v := range objects(page["entries"]) {
			e, err := portable.ReadEntry(mustJSON(v))
			if err != nil {
				return fault("invalid_request", err.Error())
			}
			p.append(e)
		}
		next := str(page, "next")
		if next == "" {
			return nil
		}
		if next == str(params, "after") {
			return fault("invalid_request", "history cursor did not advance")
		}
		params["after"] = next
	}
}
func (p *runtimeClient) append(e api.Entry) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Link the request's local view linearly. Host callbacks can interleave
	// with input/approval records that are not pushed to this view.
	e.Parent = p.view.Position
	// A host can return the existing start or call record. Do not link it
	// back to itself when the recovery view already contains that identity.
	if p.cached[e.ID] {
		return
	}
	p.cached[e.ID] = true
	p.view.Position = e.ID
	p.view.Entries = append(p.view.Entries, e)
}
func (p *runtimeClient) Snapshot() (api.Session, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	v := p.view
	v.Entries = append([]api.Entry(nil), v.Entries...)
	return v, nil
}
func (p *runtimeClient) Record(ctx context.Context, e api.Entry) (api.Entry, error) {
	e.Writer = "runtime"
	if e.Kind == "input" && e.InputID() == "" {
		id, err := p.NewID(ctx)
		if err != nil {
			return e, err
		}
		e.Data = api.JSON(id)
	}
	v := portable.Entry(e)
	if e.Kind == "model" {
		if raw := api.Decode[struct{ Wire json.RawMessage }](e.Data).Wire; len(raw) != 0 {
			v["message"] = raw
		}
	}
	for _, k := range []string{"id", "parentId", "sessionId", "time", "turnId", "actorId"} {
		delete(v, k)
	}
	var recorded object
	if err := p.call(ctx, "record", object{"entry": v}, &recorded); err != nil {
		return e, err
	}
	saved, err := portable.ReadEntry(mustJSON(recorded))
	if err != nil {
		return e, fault("invalid_request", err.Error())
	}
	p.append(saved)
	p.addEntry(saved.ID)
	return saved, nil
}
func (p *runtimeClient) NewID(ctx context.Context) (string, error) {
	var v object
	err := p.call(ctx, "newId", object{}, &v)
	return str(v, "id"), err
}
func (p *runtimeClient) PrepareStep(ctx context.Context, step string, usage api.Usage) (api.StepContext, error) {
	var v object
	err := p.call(ctx, "prepareStep", object{"stepId": step, "usage": usageOut(usage)}, &v)
	p.step = step
	return api.StepContext{Turn: p.turn, Step: step, Usage: usage, Request: requestIn(v)}, err
}
func (p *runtimeClient) Definition(ctx context.Context, name string) (api.Tool, bool, error) {
	var v object
	err := p.call(ctx, "definition", object{"toolName": name}, &v)
	return toolIn(v), v != nil, err
}
func (p *runtimeClient) Model() api.Model             { return p.model }
func (p *runtimeClient) CanRepeatCall(id string) bool { return p.repeat[id] }
func (p *runtimeClient) Generate(ctx context.Context, req api.Request, emit func(api.Part)) (api.Response, error) {
	var v object
	// Preparation returns the wire request to echo, not defaults to reapply.
	// Re-encoding typed fields can add absent settings or reshape tool definitions.
	var request any = req.Wire
	if len(req.Wire) == 0 {
		request = requestOut(req)
	}
	err := p.call(context.WithValue(ctx, modelEventKey{}, emit), "model", object{"stepId": p.step, "request": request}, &v)
	if err == nil && str(v, "stop") == "failed" {
		err = modelError(asObject(v["error"]))
	}
	if v == nil {
		return api.Response{}, err
	}
	return responseIn(v), err
}
func modelError(v object) error {
	kind := str(v, "kind")
	switch kind {
	case "contextTooLarge":
		kind = "context_too_large"
	case "temporary":
		kind = "unavailable"
	}
	message := str(v, "message")
	if message == "" {
		message = "model failed"
	}
	return &api.ModelError{Kind: kind, Message: message}
}
func (p *runtimeClient) TakeSteering(ctx context.Context) (bool, error) {
	return p.TakeSteeringBoundary(ctx, false)
}
func (p *runtimeClient) TakeSteeringBoundary(ctx context.Context, final bool) (bool, error) {
	var v object
	err := p.call(ctx, "takeSteering", object{"final": final}, &v)
	if Code(err) == "not_supported" {
		return false, nil
	}
	entries := objects(v["entries"])
	for _, v := range entries {
		e, readErr := portable.ReadEntry(mustJSON(v))
		if readErr != nil {
			return false, fault("invalid_request", readErr.Error())
		}
		p.append(e)
		p.addEntry(e.ID)
	}
	return len(entries) > 0, err
}
func (p *runtimeClient) addEntry(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, old := range p.entries {
		if old == id {
			return
		}
	}
	p.entries = append(p.entries, id)
}

func (p *runtimeClient) RunTool(ctx context.Context, c api.Call) api.ToolResult {
	result, err := p.DispatchTool(ctx, c)
	if err != nil {
		status := "unknown"
		if ctx.Err() != nil || Code(err) == "cancelled" {
			status = "cancelled"
		}
		return api.ToolResult{Call: c.ID, Name: c.Name, Status: status, Content: api.Text(err.Error())}
	}
	return result
}

func (p *runtimeClient) DispatchTool(ctx context.Context, c api.Call) (api.ToolResult, error) {
	var v object
	err := p.call(ctx, "runToolCall", object{"call": callOut(c)}, &v)
	return resultIn(v), err
}

func (p *runtimeClient) ModelAt(ctx context.Context, step string, req api.Request) (api.Response, error) {
	p.step = step
	return p.Generate(ctx, req, func(api.Part) {})
}

// The Harness owns all standard events. This Runtime has no custom events.
func (p *runtimeClient) Emit(context.Context, api.Event) {}
