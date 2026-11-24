package modular

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type agWork struct {
	key, origin string
	user        api.Content
	reports     []InterfaceToolReport
	answers     []api.Answer
	continued   bool
	names       []string
}

func (q *agRequest) plan(in agInput, suffix []agObject, c *InterfaceToolConnection) (p agWork, err error) {
	for _, o := range in.offers {
		name := agString(o, "name")
		def, ok := q.tools[name]
		params, has := o["parameters"]
		if !has {
			params = agObject{}
		}
		if !ok || slices.Contains(p.names, name) || o["description"] != def.Description || !portable.EqualJSON(api.JSON(params), def.Input) {
			return p, denied
		}
		p.names = append(p.names, name)
	}
	requests, err := q.waitingQuestions()
	if err != nil {
		return p, err
	}
	calls, err := agPending(c)
	if err != nil {
		return p, err
	}
	p.key = fmt.Sprintf("agui:%x", sha256.Sum256(api.JSON([]string{q.client, in.run})))
	for _, m := range suffix {
		if m["role"] == "user" {
			if len(suffix) != 1 || len(in.answers) != 0 {
				return p, invalid
			}
			if !q.allowed("input") {
				return p, denied
			}
			if len(requests) != 0 || len(calls) != 0 {
				return p, stale
			}
			p.user, err = agContent(m["content"], q.warn)
			return p, err
		}
		if m["role"] != "tool" {
			return p, invalid
		}
	}
	seen := map[string]bool{}
	for _, m := range suffix {
		id := agString(m, "toolCallId")
		at := slices.IndexFunc(calls, func(v harness.PendingInterfaceCall) bool { return v.CallID == id && v.Reportable })
		if at < 0 || seen[id] || p.origin != "" && p.origin != calls[at].TurnID {
			return p, stale
		}
		seen[id] = true
		p.origin, p.continued = calls[at].TurnID, true
		content, err := agContent(m["content"], q.warn)
		if err != nil {
			return p, err
		}
		status := ToolStatus("completed")
		if reason, ok := m["error"].(string); ok {
			status = "failed"
			if content.Text() == "" {
				if reason == "" {
					reason = "The Interface reported failure."
				}
				content = append(content, api.Part{Type: "text", Text: reason})
			}
		} else if len(content) == 0 {
			content = api.Text("")
		}
		report := InterfaceToolReport{CallID: id, Status: status, Content: agReport(content)}
		if len(api.JSON(report)) > 1<<20 {
			return p, tooLarge
		}
		p.reports = append(p.reports, report)
	}
	for _, wait := range calls {
		if wait.Reportable && !seen[wait.CallID] {
			return p, stale
		}
	}
	for _, ans := range in.answers {
		id := agString(ans, "interruptId")
		d, ok := requests[id]
		if !ok {
			q.warn("interruptId")
			continue
		}
		if seen[id] || p.origin != "" && p.origin != d.q.Turn {
			return p, stale
		}
		seen[id] = true
		p.origin = d.q.Turn
		if d.presence == nil || d.q.ApprovalWait == api.UntilDeadline {
			p.continued = true
		}
		a := api.Answer{Request: id, Declined: ans["status"] == "cancelled"}
		if !a.Declined {
			switch d.q.Kind {
			case "approval":
				v, ok := agMap(ans["payload"])["allow"].(bool)
				if !ok {
					return p, invalid
				}
				a.Declined = !v
				if v {
					a.Value = "allow"
				}
			case "choice", "text", "link":
				v, ok := ans["payload"].(string)
				if !ok || d.q.Kind == "choice" && !slices.Contains(d.q.Options, v) {
					return p, invalid
				}
				if len(v) > 256<<10 {
					return p, tooLarge
				}
				a.Value = v
			default:
				return p, denied
			}
		}
		p.answers = append(p.answers, a)
	}
	for id := range requests {
		if !seen[id] {
			return p, stale
		}
	}
	if len(p.reports)+len(p.answers) == 0 {
		if len(in.answers) != 0 {
			return p, stale
		}
		return p, invalid
	}
	return p, nil
}

type agExchange struct {
	presenceAtStart *agPresence
	*agRequest
	in           agInput
	work         agWork
	conn         *InterfaceToolConnection
	epoch        int
	turn, input  string
	steps        map[string]bool
	text         map[string]string
	reasoning    map[string]bool
	emittedCalls map[string]bool
	revision     string
	interrupted  bool
	terminal     bool
}

func (x *agExchange) matches(snap api.Session, turn string) bool {
	if turn == "" {
		return false
	}
	if x.work.origin != "" && !x.work.continued {
		return turn == x.work.origin
	}
	for _, e := range snap.Branch() {
		if e.Turn != turn {
			continue
		}
		if e.Kind == "turn.start" && x.work.continued {
			v := api.Decode[api.TurnStart](e.Data)
			if v.ContinuesTurn == x.work.origin {
				return true
			}
			for _, a := range x.work.answers {
				if v.StartedBy.Kind == "answer" && v.StartedBy.ID == a.Request {
					return true
				}
			}
		}
		if e.Kind == "input" && x.work.user != nil && e.InputKey == x.work.key {
			return true
		}
	}
	return false
}
func (q *agRequest) run(r *http.Request, in agInput) error {
	s := q.state
	s.mu.Lock()
	runKey := sha256.Sum256([]byte(in.run))
	if s.active || slices.Contains(s.runs, runKey) {
		s.mu.Unlock()
		return stale
	}
	s.active = true
	defer q.a.q.manager().ConnectClient(q.id, q.Actor.ID, q.client)()
	c := s.tools
	presenceAtStart := s.presence
	s.mu.Unlock()
	keep := c != nil
	defer func() {
		s.mu.Lock()
		s.active = false
		if !keep || s.presence == nil {
			if c != nil {
				c.Close()
			}
			s.tools = nil
			s.disconnect()
		} else {
			s.tools = c
		}
		s.mu.Unlock()
	}()
	if c == nil {
		var err error
		c, err = q.connect()
		if err != nil {
			return err
		}
	}
	s.snapshots.Lock()
	h, err := q.history()
	var suffix []agObject
	if err == nil {
		suffix, err = q.reconcile(h, in.messages, r.Header.Get("MA-History-Cursor"))
	}
	s.snapshots.Unlock()
	if err != nil {
		return err
	}
	p, err := q.plan(in, suffix, c)
	if err != nil {
		return err
	}
	if q.TrustTrace {
		q.ctx = telemetry.HTTPParent(q.ctx, r.Header.Get("traceparent"), r.Header.Get("tracestate"), q.opt.TraceStateKeys)
	}
	x := &agExchange{presenceAtStart: presenceAtStart, agRequest: q, in: in, work: p, conn: c, epoch: h.epoch, steps: map[string]bool{}, text: map[string]string{}, reasoning: map[string]bool{}, emittedCalls: map[string]bool{}}
	stopEvents, events, lost := x.follow()
	defer stopEvents()
	_, interrupted, err := q.host().SessionInterruption(q.id)
	if err != nil {
		return err
	}
	if err = q.fresh(h.epoch); err != nil {
		return err
	}
	var capacity <-chan struct{}
	if p.continued {
		var detach func()
		capacity, detach, err = q.host().WatchContinuation(q.id, p.origin)
		if err != nil {
			return err
		}
		defer detach()
	}
	if c != nil && !keep {
		if err = c.connection.AdvertiseFor(p.names, p.key, p.origin); err != nil {
			return denied
		}
	}
	if p.user != nil {
		ctx := api.WithInputWatermark(q.ctx, q.id, h.position, h.entries)
		receipt, err := q.a.a.Submit(ctx, q.id, api.Input{Actor: q.Actor.ID, When: "now", Key: p.key, Content: p.user})
		if err != nil {
			return err
		}
		if receipt.Duplicate || receipt.Erased {
			return stale
		}
		x.input = receipt.ID
		x.terminal = receipt.When == "command"
	} else {
		for _, a := range p.answers {
			live, err := q.waitingQuestions()
			if err != nil {
				return err
			}
			if _, ok := live[a.Request]; !ok {
				return stale
			}
			s.mu.Lock()
			d, ok := s.delivered[a.Request]
			if ok && d.presence != nil && (s.presence != d.presence || d.presence.ctx.Err() != nil) {
				s.mu.Unlock()
				return stale
			}
			if !ok && live[a.Request].presence != nil {
				s.mu.Unlock()
				return stale
			}
			s.mu.Unlock()
			if live[a.Request].q.ApprovalWait == api.UntilDeadline {
				err = q.a.a.(api.WaitingApprovalHost).AnswerWaiting(q.ctx, q.id, d.presence.instance, a)
			} else {
				err = q.a.q.manager().AnswerOnClient(q.ctx, q.id, q.client, a)
			}
			if err != nil {
				return err
			}
			s.mu.Lock()
			if s.presence != nil && s.presence.detach[a.Request] != nil {
				s.presence.detach[a.Request]()
				delete(s.presence.detach, a.Request)
			}
			delete(s.delivered, a.Request)
			if len(s.delivered) == 0 {
				s.disconnect()
			}
			s.mu.Unlock()
		}
		for _, report := range p.reports {
			d, err := c.ReportToolResult(q.ctx, report)
			if err != nil {
				return err
			}
			if d.Status != InterfaceToolAccepted {
				return stale
			}
		}
	}
	s.mu.Lock()
	if len(s.runs) >= 256 {
		s.runs = slices.Delete(s.runs, 0, 1)
	}
	s.runs = append(s.runs, runKey)
	s.mu.Unlock()
	keep = false
	q.w.Header().Set("Content-Type", "text/event-stream")
	if err = x.event(agObject{"type": "RUN_STARTED", "threadId": q.id, "runId": in.run, "protocolVersion": "1.0"}); err != nil {
		x.fail(err)
		return nil
	}
	if err = x.sendSnapshot(h); err != nil {
		x.fail(err)
		return nil
	}
	if err = x.currentState(); err != nil {
		x.fail(err)
		return nil
	}
	if x.terminal {
		err = x.finish(api.Outcome{Status: "completed"}, nil)
	} else {
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for err == nil && !x.terminal {
			select {
			case <-q.ctx.Done():
				return nil
			case <-capacity:
				err = api.ErrCapacity
			case <-lost:
				err = unavailable
			case <-interrupted:
				err = unavailable
			case e := <-events:
				raw := e.Event
				e.Release()
				if raw.ErasureEpoch != x.epoch {
					err = stale
					break
				}
				err = x.project(raw)
			case <-tick.C:
				if err = q.fresh(x.epoch); err != nil {
					break
				}
				if len(events) == 0 {
					busy, _ := q.a.h.Busy(q.id)
					if !busy && len(events) == 0 {
						snap, e := q.a.a.Snapshot(q.id)
						if e != nil {
							err = e
							break
						}
						if !p.continued || slices.ContainsFunc(snap.Branch(), func(e api.Entry) bool { return e.Kind == "turn.end" && x.matches(snap, e.Turn) }) {
							err = withheld
							break
						}
					}
				}
				_, err = fmt.Fprint(q.w, ": waiting\n\n")
				if err == nil {
					err = http.NewResponseController(q.w).Flush()
				}
			}
		}
	}
	if err != nil {
		x.fail(err)
	}
	keep = x.interrupted && err == nil
	return nil
}
func (s *agClient) disconnect() {
	if s.presence != nil && s.presence.detach != nil {
		for _, detach := range s.presence.detach {
			detach()
		}
		s.presence.detach = nil
	}
}
func (x *agExchange) follow() (func(), <-chan api.BufferedEvent, <-chan struct{}) {
	ch := make(chan api.BufferedEvent, 256)
	lost := make(chan struct{})
	var once sync.Once
	var mu sync.Mutex
	closed := false
	stop := x.host().SubscribeOutput(func(e api.Event) string {
		if e.Session == x.id {
			return x.client
		}
		return ""
	}, func(e api.Event) {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return
		}
		if e.Kind == "question.open" {
			x.offerQuestion(e)
		}
		if b, ok := api.BufferEvent(x.a.a, e); ok {
			select {
			case ch <- b:
				return
			default:
				b.Release()
			}
		}
		once.Do(func() { close(lost) })
	})
	return func() {
		stop()
		mu.Lock()
		closed = true
		for len(ch) > 0 {
			(<-ch).Release()
		}
		mu.Unlock()
	}, ch, lost
}
func (x *agExchange) offerQuestion(e api.Event) {
	candidate := api.Decode[api.Question](e.Data)
	if candidate.Kind == "secret" || !x.eligible(candidate) {
		return
	}
	snap, err := x.a.a.Snapshot(x.id)
	if err != nil || !x.matches(snap, e.Turn) {
		return
	}
	list, err := x.a.q.manager().List(x.id)
	if err != nil {
		return
	}
	for _, v := range list {
		if v.ID != candidate.ID || !x.eligible(v) {
			continue
		}
		intended := agInterrupt(v)
		if !agEqual(intended, agInterrupt(candidate)) || v.Kind == "approval" && !agEqual(v.ApprovalCall, candidate.ApprovalCall) {
			return
		}
		if _, err := x.encode("agui.interrupt", intended); err != nil {
			return
		}
		s := x.state
		s.mu.Lock()
		defer s.mu.Unlock()
		p := s.presence
		if p == nil || p != x.presenceAtStart || p.ctx.Err() != nil {
			return
		}
		if v.Kind == "approval" && p.detach[v.ID] == nil {
			if p.detach == nil {
				p.detach = map[string]func(){}
			}
			p.detach[v.ID] = x.a.q.manager().OfferApproval(x.id, x.Actor.ID, x.client, v.ID)
		}
		if s.delivered == nil {
			s.delivered = map[string]agDelivery{}
		}
		s.delivered[v.ID] = agDelivery{p, sha256.Sum256(api.JSON(intended))}
		return
	}
}
func (x *agExchange) event(v agObject) error {
	b, err := x.encode("agui.event", v)
	if err != nil {
		return err
	}
	if err = x.fresh(x.epoch); err != nil {
		return err
	}
	return x.frame(b)
}
func (x *agExchange) fail(err error) {
	_, code := agStatus(err)
	v := agObject{"type": "RUN_ERROR", "code": code, "message": "Run could not be delivered."}
	if x.event(v) != nil {
		_ = x.frame([]byte(`{"type":"RUN_ERROR","code":"output_withheld","message":"Output withheld."}`))
	}
}
func (x *agExchange) sendSnapshot(h agHistory) error {
	s := x.state
	s.snapshots.Lock()
	defer s.snapshots.Unlock()
	s.cursor = ""
	frames, cursor, err := x.snapshotFrames(h)
	if err != nil {
		return err
	}
	if err = x.fresh(h.epoch); err != nil {
		return err
	}
	for _, b := range frames {
		if err = x.frame(b); err != nil {
			return err
		}
	}
	s.cursor, s.digest = cursor, h.digest
	return nil
}
func (x *agExchange) finish(out api.Outcome, interrupts []agObject) error {
	if err := x.closeStreams(); err != nil {
		return err
	}
	if out.Status != "completed" && out.Status != "cancelled" && out.Status != "limit" {
		return agCode("unavailable")
	}
	s := x.state
	s.snapshots.Lock()
	defer s.snapshots.Unlock()
	s.cursor = ""
	h, err := x.history()
	if err != nil {
		return err
	}
	terminal := agObject{"type": "success"}
	var calls []api.Call
	var frames [][]byte
	if len(interrupts) > 0 {
		terminal = agObject{"type": "interrupt", "interrupts": interrupts}
	} else if out.Status != "completed" {
		terminal = agObject{"type": "cancelled"}
	}
	if out.Status == "completed" && len(out.Open) > 0 {
		snap, err := x.a.a.Snapshot(x.id)
		if err != nil {
			return err
		}
		handoffs := api.InterfaceHandoffs(snap)
		ids := []string{}
		for _, call := range out.Open {
			cp := handoffs[call.ID]
			if cp.ID == "" {
				continue
			}
			saved := api.Decode[api.InterfaceHandoff](cp.Data)
			if saved.Route != x.client || saved.Actor != x.Actor.ID {
				continue
			}
			if x.conn == nil {
				return withheld
			}
			var actual api.Call
			for _, e := range snap.Branch() {
				if e.ID == saved.Started && e.Kind == "tool.started" {
					actual = api.Decode[api.Call](e.Data)
					break
				}
			}
			if actual.ID != call.ID {
				return withheld
			}
			ev := api.Event{Kind: "interface.handoff", Turn: x.turn, Step: actual.Step, Call: actual.ID, Actor: x.Actor.ID, Data: api.JSON(actual)}
			g, err := x.gate(ev)
			if err != nil || !agSameBytes(g.Data, ev.Data) {
				return withheld
			}
			framesForCall, err := x.toolFrames(actual, h, nil)
			if err != nil {
				return err
			}
			frames = append(frames, framesForCall...)
			calls = append(calls, actual)
			ids = append(ids, actual.ID)
		}
		if len(ids) > 0 && len(interrupts) == 0 {
			terminal["pendingToolCallIds"] = ids
		}
	}
	final, cursor, err := x.snapshotFrames(h)
	if err != nil {
		return err
	}
	frames = append(frames, final...)
	end, err := x.encode("agui.event", agObject{"type": "RUN_FINISHED", "threadId": x.id, "runId": x.in.run, "outcome": terminal})
	if err != nil {
		return err
	}
	frames = append(frames, end)
	if err = x.fresh(x.epoch); err != nil {
		return err
	}
	if len(calls) > 0 {
		// Gate the entire executable group, not just its separately valid pieces.
		group := make([]json.RawMessage, len(frames))
		for i, b := range frames {
			group[i] = b
		}
		if _, err = x.encode("agui.release", group); err != nil {
			return err
		}
		if err = x.fresh(x.epoch); err != nil {
			return err
		}
		if err = x.conn.connection.CheckGroup(x.ctx, x.turn, calls); err != nil {
			return err
		}
	}
	var deliveries []agQuestion
	for i, b := range frames {
		if i == len(frames)-1 && len(interrupts) > 0 {
			live, err := x.questionViews(true)
			if err != nil {
				return err
			}
			for _, v := range interrupts {
				d, ok := live[agString(v, "id")]
				if !ok || !agEqual(v, d.view) {
					return stale
				}
				deliveries = append(deliveries, d)
			}
		}
		if i == len(frames)-1 && len(calls) > 0 {
			if err = x.conn.connection.ReleaseGroup(x.ctx, x.turn, calls); err != nil {
				return err
			}
		}
		if err = x.fresh(x.epoch); err != nil {
			return err
		}
		if err = x.frame(b); err != nil {
			return err
		}
	}
	s.cursor, s.digest = cursor, h.digest
	for _, d := range deliveries {
		x.rememberWaiting(d)
	}
	x.terminal = true
	x.interrupted = len(interrupts) > 0 && len(out.Open) == 0
	return nil
}
func (x *agExchange) toolFrames(c api.Call, h agHistory, result agObject) ([][]byte, error) {
	start := agObject{"type": "TOOL_CALL_START", "toolCallId": c.ID, "toolCallName": c.Name}
	if slices.ContainsFunc(h.messages, func(m agObject) bool { return m["id"] == assistantID(c.Step) }) {
		start["parentMessageId"] = assistantID(c.Step)
	}
	items := []agObject{start, {"type": "TOOL_CALL_ARGS", "toolCallId": c.ID, "delta": string(c.Input)}, {"type": "TOOL_CALL_END", "toolCallId": c.ID}}
	if result != nil {
		items = append(items, agObject{"type": "TOOL_CALL_RESULT", "messageId": result["id"], "toolCallId": c.ID, "content": result["content"], "role": "tool"})
	}
	var out [][]byte
	for _, v := range items {
		b, err := x.encode("agui.event", v)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}
func (x *agExchange) optional(event agObject) error {
	err := x.event(event)
	if errors.Is(err, withheld) || errors.Is(err, api.ErrOutputWithheld) || errors.Is(err, tooLarge) {
		return nil
	}
	return err
}
func (x *agExchange) custom(kind string, data any) error {
	return x.optional(agObject{"type": "CUSTOM", "name": "modular-agent.event", "value": agObject{"type": kind, "data": data}})
}
func agPatch(value any) bool {
	list, ok := value.([]any)
	if !ok {
		return false
	}
	pointer := func(v any) bool {
		s, ok := v.(string)
		if !ok || s != "" && s[0] != '/' {
			return false
		}
		for i := 0; i < len(s); i++ {
			if s[i] == '~' {
				i++
				if i == len(s) || s[i] != '0' && s[i] != '1' {
					return false
				}
			}
		}
		return true
	}
	for _, v := range list {
		p := agMap(v)
		if !pointer(p["path"]) {
			return false
		}
		switch p["op"] {
		case "add", "replace", "test":
			if _, ok := p["value"]; !ok {
				return false
			}
		case "copy", "move":
			if !pointer(p["from"]) {
				return false
			}
		case "remove":
		default:
			return false
		}
	}
	return true
}
func (x *agExchange) currentState() error {
	if x.opt.CurrentState == nil {
		return nil
	}
	id, raw, err := x.opt.CurrentState(x.ctx, x.id)
	if err != nil || id == "" || len(raw) == 0 {
		x.revision = ""
		return nil
	}
	return x.stateEvent("stateSnapshot", agObject{"revisionId": id, "snapshot": raw})
}
func (x *agExchange) stateEvent(kind string, data agObject) error {
	id := agString(data, "revisionId")
	if id == "" {
		x.revision = ""
		return nil
	}
	var ev agObject
	if kind == "stateSnapshot" {
		v, ok := data["snapshot"]
		if !ok {
			return nil
		}
		ev = agObject{"type": "STATE_SNAPSHOT", "snapshot": v}
	} else {
		if x.revision == "" || agString(data, "baseRevisionId") != x.revision {
			x.revision = ""
			return nil
		}
		if !agPatch(data["delta"]) {
			x.revision = ""
			return nil
		}
		ev = agObject{"type": "STATE_DELTA", "delta": data["delta"]}
	}
	if err := x.event(ev); err != nil {
		x.revision = ""
		if errors.Is(err, withheld) || errors.Is(err, api.ErrOutputWithheld) || errors.Is(err, tooLarge) {
			return nil
		}
		return err
	}
	x.revision = id
	return nil
}
func (x *agExchange) pluginEvent(e api.Event) error {
	snap, err := x.a.a.Snapshot(x.id)
	if err != nil {
		return err
	}
	var owner, name string
	for _, p := range snap.Plugins {
		if strings.HasPrefix(e.Kind, "plugin."+p+".") {
			if owner != "" {
				return nil
			} // ambiguous plugin prefix
			owner = p
			name = strings.TrimPrefix(e.Kind, "plugin."+p+".")
		}
	}
	if owner == "" {
		return nil
	}
	switch name {
	case "modular-agent.agui.stateSnapshot", "modular-agent.agui.stateDelta":
		if owner != x.opt.StatePlugin {
			return nil
		}
		if e.OutputChanged {
			x.revision = ""
			if name == "modular-agent.agui.stateDelta" {
				return nil
			}
			defer func() { x.revision = "" }()
		}
		return x.stateEvent(strings.TrimPrefix(name, "modular-agent.agui."), api.Decode[portable.Object](e.Data))
	case "modular-agent.agui.raw":
		if source := x.opt.RawSources[owner]; source != "" {
			return x.optional(agObject{"type": "RAW", "source": source, "event": e.Data})
		}
		return nil
	}
	return x.custom(name, e.Data)
}
