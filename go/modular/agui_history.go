package modular

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

func agSameBytes(a, b []byte) bool   { return bytes.Equal(a, b) || portable.EqualJSON(a, b) }
func assistantID(step string) string { return "ma:assistant:" + step }
func toolID(id string) string        { return "ma:tool:" + id }

type agHistory struct {
	messages []agObject
	starts   map[string]api.Call
	results  map[string]agObject
	digest   [32]byte
	epoch    int
}

func (q *agRequest) history(beforeStepsOf ...string) (h agHistory, err error) {
	h.epoch, err = q.epoch()
	if err != nil {
		return h, err
	}
	snap, err := q.host().ViewForOutput(q.ctx, q.id)
	if err != nil {
		return h, err
	}
	branch := snap.Branch()
	if len(beforeStepsOf) > 0 {
		for i, e := range branch {
			if e.Turn == beforeStepsOf[0] && (e.Kind == "step.start" || e.Kind == "model.request" || e.Kind == "model") {
				branch = branch[:i]
				break
			}
		}
	}
	handoffs := api.InterfaceHandoffs(snap)
	h.messages = []agObject{}
	h.starts = map[string]api.Call{}
	h.results = map[string]agObject{}
	// Gate each item before using it. A call part depends on BOTH its actual dispatch and its result.
	var visible []api.Entry
	var cutoffs []string
	for _, e := range snap.Entries {
		if e.Kind == "erasure" || e.Kind == "position" {
			cutoffs = append(cutoffs, e.ID)
		}
	}
	for _, e := range branch {
		switch e.Kind {
		case "input", "model", "tool.result", "tool.started":
		default:
			continue
		}
		if e.IsErased() || e.Kind == "tool.started" && handoffs[e.Call].ID != "" {
			continue
		}
		g, err := q.gate(api.Event{Kind: "history.added", Data: api.JSON(e), Turn: e.Turn, Step: e.Step, Call: e.Call})
		if errors.Is(err, api.ErrOutputWithheld) {
			continue
		}
		if err != nil {
			return h, err
		}
		item := api.Decode[api.Entry](g.Data)
		if item.ID != e.ID || item.Kind != e.Kind || item.Call != e.Call || item.Step != e.Step {
			continue
		}
		visible = append(visible, item)
		switch item.Kind {
		case "tool.started":
			c := api.Decode[api.Call](item.Data)
			if c.Name != "" && c.ID == item.Call && c.ParentCall == "" {
				h.starts[c.ID] = c
			}
		case "tool.result":
			r := api.Decode[api.ToolResult](item.Data)
			if r.Call != e.Call || r.Status == "" || !item.Visible {
				continue
			}
			m := agObject{"id": toolID(r.Call), "role": "tool", "toolCallId": r.Call, "content": agBody(item.Content)}
			if r.Status != "completed" {
				s := item.Content.Text()
				if s == "" {
					s = "Tool did not complete."
				}
				m["error"] = s
			}
			h.results[r.Call] = m
		}
	}
	for _, e := range visible {
		switch e.Kind {
		case "input":
			if e.Visible && e.InputID() != "" {
				h.messages = append(h.messages, agObject{"role": "user", "id": "ma:user:" + e.InputID(), "content": agBody(e.Content)})
			}
		case "model":
			if !e.Visible || e.Step == "" {
				continue
			}
			msg := agObject{"id": assistantID(e.Step), "role": "assistant"}
			if text := e.Content.Text(); text != "" {
				msg["content"] = text
			}
			calls := []agObject{}
			for _, part := range e.Content {
				if part.Call == nil {
					continue
				}
				id := part.Call.ID
				c, ok := h.starts[id]
				if !ok || h.results[id] == nil {
					continue
				}
				calls = append(calls, agObject{"id": id, "type": "function", "function": agObject{"name": c.Name, "arguments": string(c.Input)}})
			}
			if len(calls) > 0 {
				msg["toolCalls"] = calls
			}
			if len(msg) > 2 {
				h.messages = append(h.messages, msg)
			}
		case "tool.result":
			if m := h.results[e.Call]; m != nil {
				h.messages = append(h.messages, m)
			}
		}
	}
	h.digest = sha256.Sum256(api.JSON([]any{h.messages, cutoffs, h.epoch}))
	return h, q.fresh(h.epoch)
}
func (h agHistory) last() any {
	if len(h.messages) == 0 {
		return nil
	}
	return h.messages[len(h.messages)-1]["id"]
}
func (q *agRequest) reconcile(h agHistory, messages []agObject, cursor string) ([]agObject, error) {
	s := q.state
	if cursor != "" && s.cursor != cursor {
		return nil, agCode("cursor_expired")
	}
	if s.cursor == "" && len(h.messages) > 0 {
		return nil, agCode("cursor_expired")
	}
	if s.cursor != "" && h.digest != s.digest || len(messages) < len(h.messages) {
		return nil, stale
	}
	for i, m := range h.messages {
		if !agEqual(m, messages[i]) {
			return nil, stale
		}
	}
	suffix := messages[len(h.messages):]
	ids := map[string]bool{}
	for _, m := range suffix {
		id := agString(m, "id")
		if len(id) >= 3 && id[:3] == "ma:" {
			return nil, stale
		}
		if ids[id] {
			return nil, invalid
		}
		ids[id] = true
	}
	return suffix, nil
}
func (q *agRequest) connect() (*InterfaceToolConnection, error) {
	if len(q.tools) == 0 {
		return nil, nil
	}
	return q.a.ConnectInterfaceTools(q.id, InterfaceToolConnectionOptions{ActorID: q.Actor.ID, RouteID: q.client, Rights: &q.rights, Scope: q.scope})
}
func agPending(c *InterfaceToolConnection) ([]harness.PendingInterfaceCall, error) {
	if c == nil {
		return nil, nil
	}
	return c.connection.Pending()
}
func (q *agRequest) waitingQuestions() (map[string]agQuestion, error) {
	list, err := q.a.q.manager().List(q.id)
	if err != nil {
		return nil, err
	}
	s := q.state
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]agQuestion{}
	for _, v := range list {
		if !q.eligible(v) {
			continue
		}
		d, ok := s.delivered[v.ID]
		if ok && d.presence != nil && (s.presence != d.presence || d.presence.ctx.Err() != nil) {
			continue
		}
		if !ok {
			if !v.Defer || v.Kind == "approval" {
				continue
			}
			ended := false
			snap, err := q.a.a.Snapshot(q.id)
			if err != nil {
				return nil, err
			}
			for _, e := range snap.Branch() {
				if e.Turn == v.Turn && e.Kind == "turn.end" {
					ended = true
					break
				}
			}
			if !ended {
				continue
			}
			d = agQuestion{q: v, view: agInterrupt(v)}
		}
		out[v.ID] = d
	}
	return out, nil
}
func (q *agRequest) eligible(v api.Question) bool {
	right := "answer"
	if v.Kind == "approval" {
		right = "approve"
		if v.ApprovalCall == nil {
			return false
		}
	}
	return v.Answerable && v.Kind != "secret" && (len(v.Allowed) == 0 || slices.Contains(v.Allowed, q.Actor.ID)) && q.allowed(right)
}
func agInterrupt(v api.Question) agObject {
	m := agObject{"id": v.ID, "reason": v.Kind, "message": v.Prompt}
	switch v.Kind {
	case "approval":
		m["toolCallId"] = v.Call
		m["responseSchema"] = agObject{"type": "object", "properties": agObject{"allow": agObject{"type": "boolean"}}, "required": []string{"allow"}}
	case "choice":
		m["responseSchema"] = agObject{"type": "string", "enum": v.Options}
	case "link", "text":
		m["responseSchema"] = agObject{"type": "string"}
		if v.Kind == "link" {
			d := api.Decode[agObject](v.Details)
			if uri, ok := d["uri"].(string); ok {
				m["metadata"] = agObject{"modular-agent.link": uri}
			}
		}
	}
	if v.Deadline != nil && !v.Defer {
		m["expiresAt"] = v.Deadline.UTC().Format(time.RFC3339Nano)
	}
	return m
}
func (q *agRequest) snapshotHTTP() error {
	s := q.state
	s.snapshots.Lock()
	defer s.snapshots.Unlock()
	s.cursor = ""
	h, err := q.history()
	if err != nil {
		return err
	}
	cursor := api.ID()
	questions, err := q.waitingQuestions()
	if err != nil {
		return err
	}
	views := []agObject{}
	for _, d := range questions {
		views = append(views, d.view)
	}
	c, err := q.connect()
	if err != nil {
		return err
	}
	if c != nil {
		defer c.Close()
	}
	pending, err := agPending(c)
	if err != nil {
		return err
	}
	calls := []agObject{}
	for _, p := range pending {
		calls = append(calls, agObject{"toolCallId": p.CallID, "expiresAt": time.UnixMilli(p.Deadline).UTC().Format(time.RFC3339Nano)})
	}
	v := agObject{"threadId": q.id, "declaration": q.a.Declaration(), "messages": h.messages, "cursor": cursor, "lastMessageId": h.last(), "waiting": agObject{"questions": views, "toolCalls": calls}}
	b, err := q.encode("agui.snapshot", v)
	if err != nil {
		return err
	}
	if err = q.fresh(h.epoch); err != nil {
		return err
	}
	q.w.Header().Set("Content-Type", "application/json")
	if n, err := q.w.Write(b); err == nil && n == len(b) {
		s.cursor, s.digest = cursor, h.digest
	}
	return nil
}
func (q *agRequest) snapshotFrames(h agHistory) ([][]byte, string, error) {
	cursor := api.ID()
	m, err := q.encode("agui.event", agObject{"type": "MESSAGES_SNAPSHOT", "messages": h.messages})
	if err != nil {
		return nil, "", err
	}
	c, err := q.encode("agui.event", agObject{"type": "CUSTOM", "name": "modular-agent.history", "value": agObject{"cursor": cursor, "lastMessageId": h.last()}})
	if err != nil {
		return nil, "", err
	}
	return [][]byte{m, c}, cursor, nil
}

// agTraceContext is used only after authenticating and attaching the work POST.
func agReport(c api.Content) Content { return api.Decode[Content](api.JSON(portable.Content(c))) }
func agData(raw json.RawMessage) any { return json.RawMessage(raw) }
