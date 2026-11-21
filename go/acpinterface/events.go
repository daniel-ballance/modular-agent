package acpinterface

import (
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"slices"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func (s *server) update(ctx context.Context, id string, u acp.SessionUpdate) error {
	st, err := s.attached(id)
	if err != nil || ctx.Err() != nil || !s.canDeliver(st, id, st.actor) {
		return acpError("forbidden")
	}
	return s.peer.SessionUpdate(ctx, acp.SessionNotification{SessionId: acp.SessionId(id), Update: u})
}
func (s *server) outputRecipient(e api.Event) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.sessions[e.Session]; st != nil && !s.closed && s.authorize(e.Session, st.actor, "watch") {
		return st.actor
	}
	return ""
}
func (s *server) event(e api.Event) {
	if epoch, err := s.erasureEpoch(e.Session); err != nil || epoch != e.ErasureEpoch {
		return
	}
	if e.Kind == "session.leave" {
		s.setPresence(e.Session, e.Actor, false)
	}
	s.mu.Lock()
	st := s.sessions[e.Session]
	if st == nil || s.closed || !s.authorize(e.Session, st.actor, "watch") {
		s.mu.Unlock()
		return
	}
	if st.loading {
		// Optional live updates may be dropped while replay is blocked.
		if len(st.pending) < 256 && len(e.Data) <= 64<<10 {
			st.pending = append(st.pending, e)
		}
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	var u *acp.SessionUpdate
	switch e.Kind {
	case "question.open":
		s.ask(st, api.Decode[api.Question](e.Data))
	case "question.closed":
		s.cancelQuestion(st, api.Decode[struct{ QuestionID string }](e.Data).QuestionID)
	case "question.answered":
		s.cancelQuestion(st, api.Decode[api.Answer](e.Data).Request)
	case "model.delta":
		p := api.Decode[api.Part](e.Data)
		if p.Type == "text" || p.Type == "reasoning" {
			s.mu.Lock()
			st.streamed[e.Step] = true
			s.mu.Unlock()
			v := acp.UpdateAgentMessageText(p.Text)
			if p.Type == "reasoning" {
				v = acp.UpdateAgentThoughtText(p.Text)
			}
			u = &v
		}
	case "history.added":
		entry := api.Decode[api.Entry](e.Data)
		if entry.Kind == "model" {
			s.mu.Lock()
			st.models[e.Step] = entry.Content
			s.mu.Unlock()
		}
	case "model.stream.end":
		s.mu.Lock()
		content, streamed := st.models[e.Step], st.streamed[e.Step]
		s.mu.Unlock()
		if !streamed {
			for _, p := range content {
				s.part(st.ctx, e.Session, p, false)
			}
		}
	case "step.end":
		s.mu.Lock()
		delete(st.models, e.Step)
		delete(st.streamed, e.Step)
		s.mu.Unlock()
	case "tool.requested":
		c := api.Decode[api.Call](e.Data)
		v := startCall(c)
		u = &v
	case "tool.started":
		v := acp.UpdateToolCall(acp.ToolCallId(e.Call), acp.WithUpdateStatus(acp.ToolCallStatusInProgress))
		u = &v
	case "tool.progress":
		s.mu.Lock()
		var content api.Content
		if json.Unmarshal(e.Data, &content) == nil {
			st.progress[e.Call] += content.Text()
		} else {
			st.progress[e.Call] += api.Decode[string](e.Data)
		}
		value := st.progress[e.Call]
		s.mu.Unlock()
		v := acp.UpdateToolCall(acp.ToolCallId(e.Call), acp.WithUpdateContent([]acp.ToolCallContent{acp.ToolContent(acp.TextBlock(value))}))
		u = &v
	case "tool.end":
		r := api.Decode[api.ToolResult](e.Data)
		status := acp.ToolCallStatusCompleted
		if r.Status != "completed" {
			status = acp.ToolCallStatusFailed
		}
		v := acp.UpdateToolCall(acp.ToolCallId(e.Call), acp.WithUpdateStatus(status), acp.WithUpdateRawOutput(r), acp.WithUpdateContent([]acp.ToolCallContent{acp.ToolContent(acp.TextBlock(r.Content.Text()))}))
		u = &v
		s.mu.Lock()
		delete(st.progress, e.Call)
		s.mu.Unlock()
	case "turn.end":
		for _, call := range api.Decode[api.Outcome](e.Data).Open {
			_ = s.update(st.ctx, e.Session, acp.UpdateToolCall(acp.ToolCallId(call.ID), acp.WithUpdateStatus(acp.ToolCallStatusPending)))
		}
	case "setting":
		if opts, err := s.config(e.Session); err == nil {
			v := acp.SessionUpdate{ConfigOptionUpdate: &acp.SessionConfigOptionUpdate{SessionUpdate: "config_option_update", ConfigOptions: opts}}
			u = &v
		}
	}
	if u != nil {
		_ = s.update(st.ctx, e.Session, *u)
	}
	s.mu.Lock()
	events := s.capabilities.Meta[Namespace]
	s.mu.Unlock()
	var cap struct {
		Events bool `json:"events"`
	}
	_ = json.Unmarshal(events, &cap)
	if !s.canDeliver(st, e.Session, st.actor) {
		return
	}
	if e.Kind == api.SessionInterrupted {
		// The binding's projection of session interrupted (docs/bindings/acp.md, Updates).
		var data struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(e.Data, &data)
		_ = s.peer.NotifyExtension(st.ctx, "_modular-agent/interrupted", map[string]any{"sessionId": e.Session, "reason": data.Reason})
	}
	if cap.Events {
		_ = s.peer.NotifyExtension(st.ctx, "_modular-agent/event", e)
	}
}
func (s *server) part(ctx context.Context, id string, p api.Part, user bool) {
	if p.Type != "text" && p.Type != "reasoning" {
		return
	}
	u := acp.UpdateAgentMessageText(p.Text)
	if user {
		u = acp.UpdateUserMessageText(p.Text)
	} else if p.Type == "reasoning" {
		u = acp.UpdateAgentThoughtText(p.Text)
	}
	_ = s.update(ctx, id, u)
}
func (s *server) replayEntry(ctx context.Context, id string, e api.Entry) {
	switch e.Kind {
	case "input":
		for _, p := range e.Content {
			s.part(ctx, id, p, true)
		}
	case "model":
		for _, p := range e.Content {
			s.part(ctx, id, p, false)
		}
	case "tool.call":
		c := api.Decode[api.Call](e.Data)
		_ = s.update(ctx, id, startCall(c))
	case "tool.result":
		r := api.Decode[api.ToolResult](e.Data)
		status := acp.ToolCallStatusCompleted
		if r.Status != "completed" {
			status = acp.ToolCallStatusFailed
		}
		_ = s.update(ctx, id, acp.UpdateToolCall(acp.ToolCallId(r.Call), acp.WithUpdateStatus(status), acp.WithUpdateRawOutput(r), acp.WithUpdateContent([]acp.ToolCallContent{acp.ToolContent(acp.TextBlock(r.Content.Text()))})))
	}
}
func startCall(c api.Call) acp.SessionUpdate {
	v := acp.StartToolCall(acp.ToolCallId(c.ID), c.Name, acp.WithStartName(c.Name), acp.WithStartRawInput(json.RawMessage(c.Input)))
	if c.ParentCall != "" {
		v.ToolCall.Meta = map[string]json.RawMessage{Namespace: api.JSON(map[string]string{"parentToolCallId": c.ParentCall})}
	}
	return v
}
func represented(snap api.Session, event api.Event) bool {
	for _, e := range snap.Branch() {
		switch event.Kind {
		case "history.added":
			if api.Decode[api.Entry](event.Data).ID == e.ID {
				return true
			}
		case "model.delta", "model.stream.end":
			if e.Kind == "model" && e.Step == event.Step {
				return true
			}
		case "tool.requested":
			if e.Kind == "tool.call" && e.Call == event.Call {
				return true
			}
		case "tool.started":
			if e.Kind == "tool.started" && e.Call == event.Call {
				return true
			}
		case "tool.end":
			if e.Kind == "tool.result" && e.Call == event.Call {
				return true
			}
		}
	}
	return false
}

// Separate the write and wait lifetimes. If the client sees the request and
// cancels its turn before Dispatch returns, the host can still cancel the
// written request instead of silently abandoning it mid-write.
func requestQuestion[T any](wait, connection context.Context, peer *acp.AgentSideConnection, method string, params any) (T, error) {
	var zero T
	if err := wait.Err(); err != nil {
		return zero, err
	}
	// Check with the longest numeric ID before preparing a request, so an
	// oversized question is withheld without failing the writer connection.
	frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": -9007199254740991, "method": method, "params": params})
	if err != nil {
		return zero, err
	}
	if len(frame) > wswire.MaxFrame {
		return zero, api.ErrOutputWithheld
	}
	request, err := acp.PrepareAgentRequest[T](peer, method, params)
	if err != nil {
		return zero, err
	}
	defer request.Abandon()
	if err := request.Dispatch(connection, acp.DispatchOptions{}); err != nil {
		return zero, err
	}
	result, err := request.Wait(wait)
	if wait.Err() != nil {
		ctx, cancel := context.WithTimeout(connection, time.Second)
		defer cancel()
		_ = request.CancelRequest(ctx)
	}
	return result, err
}

type questionRecipient struct{ id, actor string }

func (s *server) cancelQuestion(st *attachment, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, cancel := range st.requests {
		if k.id == id {
			cancel()
		}
	}
}
func (s *server) ask(st *attachment, q api.Question) {
	s.mu.Lock()
	present := []string{st.actor}
	for who := range st.joined {
		present = append(present, who)
	}
	s.mu.Unlock()
	available := false
	for _, who := range present {
		if s.askActor(st, q, who) {
			available = true
		}
	}
	if q.Kind == "approval" && !available {
		if refuser, ok := s.questions().(interface{ RefuseUndeliverableApproval(api.Question) }); ok {
			refuser.RefuseUndeliverableApproval(q)
		}
	}
}

func (s *server) askActor(st *attachment, q api.Question, who string) bool {
	if !s.eligible(st, q, who) {
		return false
	}
	var permission acp.RequestPermissionRequest
	if q.Kind == "approval" {
		call := s.approvalCall(q)
		if call.ID == "" {
			return false
		}
		view := requestValue(q)
		view["call"] = map[string]any{"name": call.Name, "input": call.Input}
		permission = acp.RequestPermissionRequest{
			SessionId: acp.SessionId(q.Session),
			Meta:      map[string]json.RawMessage{Namespace: api.JSON(view), "modular-agent/answeringActor": api.JSON(who)},
			ToolCall:  acp.ToolCallUpdate{ToolCallId: acp.ToolCallId(call.ID), Name: acp.Ptr(call.Name), RawInput: call.Input, Title: acp.Ptr(q.Prompt)},
			Options:   []acp.PermissionOption{{OptionId: "allow", Name: "Allow", Kind: acp.PermissionOptionKindAllowOnce}, {OptionId: "refuse", Name: "Refuse", Kind: acp.PermissionOptionKindRejectOnce}},
		}
		original := api.JSON(permission)
		if gate, ok := s.a.(outputGate); ok {
			event, err := gate.OutputValue(api.AsActor(st.ctx, who), api.Event{Kind: "interface.request", Session: q.Session, Method: "session/request_permission", Data: original})
			if err != nil || !portable.EqualJSON(original, event.Data) {
				polled, _ := s.projectRequests(st.ctx, st, q.Session, who, false)
				for _, item := range api.Decode[struct{ Requests []map[string]any }](api.JSON(polled)).Requests {
					if item["id"] == q.ID && item["answerable"] == true {
						return true
					}
				}
				return false
			}
		}
		view["answerable"] = true
		permission.Meta[Namespace] = api.JSON(view)
	}
	if snap, err := s.a.Snapshot(q.Session); err == nil {
		for _, e := range snap.Branch() {
			if e.Kind == "turn.end" && e.Turn == q.Turn {
				return false
			}
		}
	}
	key := questionRecipient{q.ID, who}
	s.mu.Lock()
	if s.closed || s.sessions[q.Session] != st || who != st.actor && st.joined[who] == nil {
		s.mu.Unlock()
		return false
	}
	if st.requests[key] != nil {
		s.mu.Unlock()
		return true
	}
	caps := s.capabilities
	// Deferred questions and clients without forms use requests/answer instead.
	if (q.Kind == "text" || q.Kind == "choice") && (caps.Elicitation == nil || caps.Elicitation.Form == nil) {
		s.mu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(st.ctx)
	st.requests[key] = cancel
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		defer cancel()
		defer func() { s.mu.Lock(); delete(st.requests, key); s.mu.Unlock() }()
		if !s.canDeliver(st, q.Session, who) || !s.eligible(st, q, who) {
			return
		}
		answer := api.Answer{Request: q.ID, Declined: true}
		meta := map[string]json.RawMessage{Namespace: api.JSON(q), "modular-agent/answeringActor": api.JSON(who)}
		switch q.Kind {
		case "approval":
			response, err := requestQuestion[acp.RequestPermissionResponse](ctx, st.ctx, s.peer, acp.ClientMethodSessionRequestPermission, permission)
			if err == nil && response.Outcome.Selected != nil {
				value := string(response.Outcome.Selected.OptionId)
				if value == "allow" || value == "refuse" {
					answer.Value = value
					answer.Declined = false
				}
			}
		case "text", "choice":
			if caps.Elicitation != nil && caps.Elicitation.Form != nil {
				field := map[string]any{"type": "string"}
				if q.Kind == "choice" {
					field["enum"] = q.Options
				}
				response, err := requestQuestion[acp.CreateElicitationResponse](ctx, st.ctx, s.peer, acp.ClientMethodElicitationCreate, acp.CreateElicitationRequest{Form: &acp.CreateElicitationForm{Mode: "form", Message: q.Prompt, Meta: meta, SessionId: acp.Ptr(acp.SessionId(q.Session)), ToolCallId: acp.Ptr(acp.ToolCallId(q.Call)), RequestedSchema: acp.ElicitationSchema{Type: "object", Properties: map[string]any{"answer": field}, Required: []string{"answer"}}}})
				if err == nil && response.Accept != nil {
					raw := api.JSON(response.Accept.Content)
					var values map[string]any
					if json.Unmarshal(raw, &values) == nil {
						value, ok := values["answer"].(string)
						if ok && (q.Kind != "choice" || slices.Contains(q.Options, value)) {
							answer.Value = value
							answer.Declined = false
						}
					}
				}
			}
			// ACP forbids asking for credentials in forms. Secrets are declined, never
			// silently downgraded to free text. A secure out-of-band flow can answer
			// through the explicit extension instead.
		}
		if ctx.Err() == nil && s.canDeliver(st, q.Session, who) && s.eligible(st, q, who) {
			_ = s.answerFor(s.acting(ctx, q.Session, st.actor), q.Session, who, answer)
		}
	}()
	return true
}
