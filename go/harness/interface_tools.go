package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"go.opentelemetry.io/otel/trace"
)

const interfacePlugin = "interface-tools"

func (h *Harness) SupportsInterfaceTools() bool       { return len(h.interfaceTools) != 0 }
func (c *client) SupportsInterfaceTools() bool        { return c.h.SupportsInterfaceTools() }
func (p *turnPorts) IsInterfaceTool(name string) bool { return p.c.h.interfaceTools[name] != nil }
func (p *turnPorts) SupportsInterfaceTools() bool     { return p.c.h.SupportsInterfaceTools() }

type InterfaceSource struct {
	ID, Actor, Route string
	TimeoutMS        int64
	Definitions      []api.Tool
}

type interfaceSource struct{ InterfaceSource }

func (s *interfaceSource) Tools(api.Session) []api.Tool { return clone(s.Definitions) }
func (*interfaceSource) Run(_ context.Context, _ api.Session, call api.Call, _ func(string)) api.ToolResult {
	return api.ToolResult{Call: call.ID, Status: "refused", Content: api.Text("Interface tools require a model handoff."), NotDispatched: true}
}

func (h *Harness) RegisterInterfaceTools(sources []InterfaceSource) error {
	if len(sources) == 0 {
		return nil
	}
	runtime, err := h.API().Get("runtime")
	if err != nil || !runtime.(api.Runtime).Declaration().InterfaceTools {
		return errors.New("Interface tools require a Runtime with result-only continuations")
	}
	routes, ids := map[string]string{}, map[string]bool{}
	byName := map[string]*interfaceSource{}
	for _, spec := range sources {
		if spec.ID == "" || ids[spec.ID] || spec.Actor == "" || spec.Route == "" || spec.TimeoutMS <= 0 || spec.TimeoutMS > api.MaxSharedTime-worktime.Now().UnixMilli() || len(spec.Definitions) == 0 {
			return errors.New("invalid Interface tool source")
		}
		if actor := routes[spec.Route]; actor != "" && actor != spec.Actor {
			return errors.New("Interface route has more than one executor actor")
		}
		routes[spec.Route], ids[spec.ID] = spec.Actor, true
		source := &interfaceSource{clone(spec)}
		for _, def := range source.Definitions {
			if def.Name == "" || !slices.Equal(def.Callers, []string{"model"}) || def.SafeRepeat || def.UsesWorkingEnvironment {
				return fmt.Errorf("invalid Interface tool definition %q", def.Name)
			}
			if byName[def.Name] != nil {
				return fmt.Errorf("duplicate tool %s", def.Name)
			}
			byName[def.Name] = source
		}
	}
	if err := h.Load(api.Plugin{Name: interfacePlugin, Setup: func(a api.API) error {
		for _, spec := range sources {
			if err := a.Provide("tools."+spec.ID, byName[spec.Definitions[0].Name]); err != nil {
				return err
			}
		}
		return nil
	}}); err != nil {
		return err
	}
	h.interfaceTools = byName
	return nil
}

// InterfaceConnection is an independently authenticated, session-scoped route.
// The transport supplies the principal, scope and ceiling from operator configuration.
type InterfaceConnection struct {
	s            *session
	c            *client
	actor, route string
	rights       *[]string
	scope        func(project, tenant string) bool
	advertised   map[string]bool
	notify       chan struct{}
	staged       map[string]stagedInterfaceCall
	closed       bool
}

type stagedInterfaceCall struct {
	ports    *turnPorts
	entry    api.Entry
	validate func(api.Call) error
}

func (h *Harness) ConnectInterface(sessionID, actor, route string, ceiling *[]string, scope func(project, tenant string) bool) (*InterfaceConnection, error) {
	c := &client{h: h, owner: "harness"}
	s, err := c.find(sessionID)
	if err != nil {
		return nil, err
	}
	configured := false
	for _, source := range h.interfaceTools {
		if source.Actor == actor && source.Route == route {
			configured = true
			break
		}
	}
	if !configured {
		return nil, api.ErrAuthority
	}
	conn := &InterfaceConnection{s: s, c: c, actor: actor, route: route, scope: scope, notify: make(chan struct{}), staged: map[string]stagedInterfaceCall{}}
	if ceiling != nil {
		rights := slices.Clone(*ceiling)
		conn.rights = &rights
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !conn.allowedLocked("watch", nil) {
		return nil, api.ErrAuthority
	}
	s.interfaceConnections = append(s.interfaceConnections, conn)
	return conn, nil
}

func (i *InterfaceConnection) allowedLocked(right string, saved []string) bool {
	return !i.closed && !i.s.closing && !i.s.opening && (i.scope == nil || i.scope(i.s.data.Project, i.s.data.Tenant)) &&
		(i.rights == nil || slices.Contains(*i.rights, right)) && (saved == nil || slices.Contains(saved, right)) && i.c.authorized(i.s.data, i.actor, right)
}

func (i *InterfaceConnection) Advertise(names []string) error {
	i.s.mu.Lock()
	defer i.s.mu.Unlock()
	if !i.allowedLocked("watch", nil) {
		return api.ErrAuthority
	}
	available := map[string]bool{}
	for _, name := range names {
		src := i.c.h.interfaceTools[name]
		if src == nil || src.Actor != i.actor || src.Route != i.route {
			return errors.New("tool is not registered for this Interface route")
		}
		available[name] = true
	}
	i.advertised = available
	return nil
}

func (i *InterfaceConnection) wakeLocked() { close(i.notify); i.notify = make(chan struct{}) }
func (i *InterfaceConnection) closeLocked() {
	i.closed = true
	i.advertised = nil
	clear(i.staged)
	i.wakeLocked()
}
func (i *InterfaceConnection) Close() {
	i.s.mu.Lock()
	defer i.s.mu.Unlock()
	if !i.closed {
		i.closeLocked()
		i.s.interfaceConnections = slices.DeleteFunc(i.s.interfaceConnections, func(other *InterfaceConnection) bool { return other == i })
	}
}

func (i *InterfaceConnection) canReceiveLocked(source *interfaceSource, name string) bool {
	return i.actor == source.Actor && i.route == source.Route && i.advertised[name] && i.allowedLocked("watch", nil) && i.allowedLocked("tools", nil)
}

func (h *Harness) interfaceAvailable(s *session, source *interfaceSource, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.interfaceConnections, func(i *InterfaceConnection) bool { return i.canReceiveLocked(source, name) })
}

func (p *turnPorts) PruneSettledInterfaceCalls(open []api.Call) []api.Call {
	if len(open) == 0 {
		return open
	}
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	handoffs := api.InterfaceHandoffs(p.s.data)
	return slices.DeleteFunc(slices.Clone(open), func(call api.Call) bool {
		return handoffs[call.ID].ID != "" && interfaceTerminal(p.s.data, call.ID).ID != ""
	})
}

func (p *turnPorts) rawSnapshot() api.Session {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	return copySession(p.s.data)
}

func (p *turnPorts) DispatchInterface(ctx context.Context, call api.Call, lineage string, validate func(api.Call) error) (api.ToolResult, bool) {
	src := p.c.h.interfaceTools[call.Name]
	if src == nil {
		return api.ToolResult{}, false
	}
	refuse := func(reason string) (api.ToolResult, bool) {
		toolDisposition(ctx, call, "refused")
		return api.ToolResult{Call: call.ID, Status: "refused", NotDispatched: true, Content: api.Text(reason)}, true
	}
	defIndex := slices.IndexFunc(p.tools, func(d api.Tool) bool { return d.Name == call.Name })
	plugin, source, current, found := p.ToolRegistration(call.Name)
	if !found || plugin != interfacePlugin || source != src.ID || defIndex < 0 || !portable.EqualJSON(api.JSON(portable.Tool(current)), api.JSON(portable.Tool(p.tools[defIndex]))) {
		return refuse("Interface tool registration changed.")
	}
	if p.id == "" || call.Step == "" || call.Origin != "model" || call.ParentCall != "" || defIndex < 0 || !p.canRunTools(call.Actor) {
		return refuse("Interface tool is not authorized or offered.")
	}
	def := p.tools[defIndex]
	if err := validateToolInput(def, call.Input); err != nil {
		return api.ToolResult{Call: call.ID, Status: "failed", NotDispatched: true, Content: api.Text(err.Error())}, true
	}
	s := p.s
	s.mu.Lock()
	at := slices.IndexFunc(s.interfaceConnections, func(i *InterfaceConnection) bool { return i.canReceiveLocked(src, call.Name) })
	if at < 0 {
		s.mu.Unlock()
		return refuse("Interface tool is unavailable.")
	}
	conn := s.interfaceConnections[at]
	s.mu.Unlock()
	event := api.Event{Kind: "interface.handoff", Session: s.id, Turn: p.id, Step: call.Step, Call: call.ID, Actor: conn.actor, Data: api.JSON(call)}
	out, err := p.c.OutputValue(api.WithConnectionRights(api.AsActor(ctx, conn.actor), conn.rights), event)
	if err != nil || !portable.EqualJSON(api.JSON(event), api.JSON(out)) {
		return refuse("Interface handoff was withheld or changed by the output gate.")
	}
	if validate != nil {
		if err := validate(call); err != nil {
			return refuse("Interface tool allowance is no longer valid.")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileErasureLocked(); err != nil {
		return refuse("Interface handoff could not check erasure.")
	}
	if ctx.Err() != nil || s.checkWriterLocked() != nil || !p.canRunToolsLocked(call.Actor) || !conn.canReceiveLocked(src, call.Name) || !offeredInterface(s.data, p.id, call) {
		return refuse("Interface tool is no longer authorized or available.")
	}
	if api.InterfaceHandoffs(s.data)[call.ID].ID != "" || interfaceTerminal(s.data, call.ID).ID != "" {
		return refuse("Interface tool call already started or settled.")
	}
	deadline := worktime.Now().UnixMilli() + src.TimeoutMS
	if deadline > api.MaxSharedTime {
		return refuse("Interface deadline cannot be represented.")
	}
	var ceiling []string
	for _, right := range api.Rights {
		if conn.allowedLocked(right, nil) {
			ceiling = append(ceiling, right)
		}
	}
	next := s.data
	next.Entries = slices.Clip(next.Entries)
	var sources []string
	if lineage != "" {
		sources = append(sources, lineage)
	}
	for _, e := range s.data.Branch() {
		if e.Kind == "model" && e.Step == call.Step {
			sources = append(sources, e.ID)
		}
	}
	start := appendEntry(&next, api.Entry{Kind: "tool.started", Turn: p.id, Step: call.Step, Call: call.ID, Actor: call.Actor, Data: api.JSON(call), Copies: sources, SafeToRepeat: new(false), OpenWorld: new(true), Wire: api.JSON(map[string]any{"data": map[string]any{"source": map[string]any{"plugin": interfacePlugin, "toolSource": src.ID}, "definition": portable.Tool(def)}})}, "harness", true)
	checkpoint := appendEntry(&next, api.Entry{Kind: api.InterfaceHandoffKind, Turn: p.id, Step: call.Step, Call: call.ID, Copies: []string{start.ID}, Data: api.JSON(api.InterfaceHandoff{Started: start.ID, Actor: src.Actor, Route: src.Route, Rights: ceiling, Deadline: deadline})}, "harness", true)
	if err := s.commitLocked(next, ctx); err != nil {
		return api.ToolResult{Call: call.ID, Status: "not_started", NotDispatched: true, ProcessingError: err}, true
	}
	_, span := startTool(ctx, call)
	if s.interfaceSpans == nil {
		s.interfaceSpans = map[string]trace.SpanContext{}
	}
	s.interfaceSpans[call.ID] = span.SpanContext()
	endTool(span, api.ToolResult{Status: "pending"}, nil)
	if s.interfaceUnreleased == nil {
		s.interfaceUnreleased = map[string]bool{}
	}
	s.interfaceUnreleased[call.ID] = true
	conn.staged[checkpoint.ID] = stagedInterfaceCall{ports: p, entry: checkpoint, validate: validate}
	conn.wakeLocked()
	p.c.h.armInterfaceTimerLocked(s)
	return api.ToolResult{Call: call.ID, Status: "interfacePending"}, true
}

func offeredInterface(s api.Session, turn string, call api.Call) bool {
	for _, e := range s.Branch() {
		if e.Turn == turn && e.Step == call.Step && e.Kind == "model.request" && e.OfferedTools != nil && slices.Contains(*e.OfferedTools, call.Name) {
			return true
		}
	}
	return false
}

// NextHandoff releases a staged call only on the connection which received it.
// No history or reconnect path can recreate a ticket.
func (i *InterfaceConnection) NextHandoff(ctx context.Context) (api.Call, error) {
	s := i.s
	for {
		s.mu.Lock()
		if ctx.Err() != nil || !i.allowedLocked("watch", nil) || !i.allowedLocked("tools", nil) {
			s.mu.Unlock()
			return api.Call{}, errors.Join(ctx.Err(), api.ErrAuthority)
		}
		var ticket stagedInterfaceCall
		for _, item := range i.staged {
			if ticket.entry.ID == "" || item.entry.Time.Before(ticket.entry.Time) {
				ticket = item
			}
		}
		if ticket.entry.ID == "" {
			notify := i.notify
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return api.Call{}, ctx.Err()
			case <-notify:
			}
			continue
		}
		delete(i.staged, ticket.entry.ID)
		call, _, _ := i.c.h.restoreInterface(s.data, ticket.entry)
		s.mu.Unlock()
		if call.ID == "" || (ticket.validate != nil && ticket.validate(call) != nil) {
			continue
		}
		s.mu.Lock()
		err := s.reconcileErasureLocked()
		current, handoff, valid := i.c.h.restoreInterface(s.data, ticket.entry)
		valid = valid && ctx.Err() == nil && s.checkWriterLocked() == nil && i.canReceiveLocked(i.c.h.interfaceTools[call.Name], call.Name) && interfaceTerminal(s.data, call.ID).ID == "" && handoff.Deadline > worktime.Now().UnixMilli() && ticket.ports.canRunToolsLocked(call.Actor) && !interfaceTurnFailed(s.data, ticket.entry.Turn)
		if err == nil && valid {
			err = s.withErasureCheck(s.data, func() error { delete(s.interfaceUnreleased, call.ID); return nil })
		}
		s.mu.Unlock()
		if err != nil {
			return api.Call{}, err
		}
		if valid {
			return clone(current), nil
		}
	}
}

func interfaceTerminal(s api.Session, id string) api.Entry {
	for _, e := range s.LiveEntries() {
		if e.Call == id && e.WasKind("tool.result") {
			return e
		}
	}
	return api.Entry{}
}

func interfaceTurnFailed(s api.Session, turn string) bool {
	for _, e := range s.Branch() {
		if e.WasKind("turn.end") && e.Turn == turn {
			return api.Decode[api.Outcome](e.Data).Status != "completed"
		}
	}
	return false
}

func hasOpenInterfaces(s api.Session) bool {
	for id := range api.InterfaceHandoffs(s) {
		if interfaceTerminal(s, id).ID == "" {
			return true
		}
	}
	return false
}

func (h *Harness) restoreInterface(s api.Session, checkpoint api.Entry) (api.Call, api.InterfaceHandoff, bool) {
	saved := api.Decode[api.InterfaceHandoff](checkpoint.Data)
	if checkpoint.Kind != api.InterfaceHandoffKind || checkpoint.IsErased() || checkpoint.Writer != "harness" || saved.Rights == nil || saved.Deadline <= 0 || saved.Deadline > api.MaxSharedTime || saved.Started != checkpoint.Parent || saved.Actor == "" || saved.Route == "" {
		return api.Call{}, saved, false
	}
	branch := s.Branch()
	if !slices.ContainsFunc(branch, func(e api.Entry) bool { return e.ID == checkpoint.ID && !e.IsErased() }) {
		return api.Call{}, saved, false
	}
	for _, e := range branch {
		if e.ID != saved.Started || e.Kind != "tool.started" || e.IsErased() || e.Call != checkpoint.Call || e.Turn != checkpoint.Turn || e.Step != checkpoint.Step || e.SafeToRepeat == nil || *e.SafeToRepeat || e.OpenWorld == nil || !*e.OpenWorld {
			continue
		}
		call := api.Decode[api.Call](e.Data)
		src := h.interfaceTools[call.Name]
		if call.ID == checkpoint.Call && call.Step == checkpoint.Step && call.Origin == "model" && src != nil && src.Actor == saved.Actor && src.Route == saved.Route {
			data := api.Decode[struct {
				Data struct {
					Source     api.ToolRegistration
					Definition json.RawMessage
				}
			}](e.Wire).Data
			if data.Source.Plugin != interfacePlugin || data.Source.ToolSource != src.ID {
				break
			}
			for _, def := range src.Definitions {
				if def.Name == call.Name && portable.EqualJSON(data.Definition, api.JSON(portable.Tool(def))) {
					return call, saved, true
				}
			}
		}
	}
	return api.Call{}, saved, false
}

func (h *Harness) appendInterfaceResultLocked(s *session, checkpoint api.Entry, result api.ToolResult, actor string, ctx context.Context) (api.Entry, error) {
	opts := []trace.SpanStartOption{trace.WithAttributes(telemetry.String("modular_agent.tool.call.id", checkpoint.Call), telemetry.String("modular_agent.tool.status", toolStatus(result.Status)))}
	if sc := s.interfaceSpans[checkpoint.Call]; sc.IsValid() {
		opts = append(opts, trace.WithLinks(trace.Link{SpanContext: sc}))
	}
	if actor == "" {
		ctx = trace.ContextWithSpanContext(ctx, trace.SpanContext{})
	}
	ctx, span := telemetry.Start(telemetry.Scope(ctx, s.id, checkpoint.Turn, checkpoint.Step, h.agentName), "modular_agent.tool.settle", opts...)
	var err error
	defer func() { telemetry.Finish(span, err) }()
	start := checkpoint.Parent
	if saved := api.Decode[api.InterfaceHandoff](checkpoint.Data); saved.Started != "" {
		start = saved.Started
	}
	copies := []string{checkpoint.ID}
	if start != "" {
		copies = append([]string{start}, copies...)
	}
	result.Call = checkpoint.Call
	result.Content = clone(result.Content)
	next := s.data
	next.Entries = slices.Clip(next.Entries)
	entry := appendEntry(&next, api.Entry{Kind: "tool.result", Turn: checkpoint.Turn, Step: checkpoint.Step, Call: checkpoint.Call, Actor: actor, Visible: true, Content: result.Content, Data: api.JSON(result), Copies: copies}, "harness", true)
	entry.Actor = actor // System settlement has no reporting actor.
	next.Entries[len(next.Entries)-1] = entry
	err = s.commitLocked(next, ctx)
	if err == nil {
		delete(s.interfaceSpans, checkpoint.Call)
		delete(s.interfaceUnreleased, checkpoint.Call)
		for _, conn := range s.interfaceConnections {
			delete(conn.staged, checkpoint.ID)
		}
	}
	return entry, err
}

func (h *Harness) settleInterfaceUnknownLocked(s *session, cp api.Entry, reason string) error {
	result := api.ToolResult{Status: "unknown", Content: api.Text(reason)}
	if s.interfaceUnreleased[cp.Call] {
		result.Status, result.Content = "not_started", api.Text("The Interface handoff was staged but not released.")
	}
	for _, e := range s.data.LiveEntries() {
		if e.ID == cp.Parent && !e.IsErased() {
			c := api.Decode[api.Call](e.Data)
			result.Name, result.Reference = c.Name, c.Reference
			break
		}
	}
	_, err := h.appendInterfaceResultLocked(s, cp, result, "", context.Background())
	return err
}

func (h *Harness) settleInterfacesLocked(s *session, turn, reason string) error {
	for _, cp := range api.InterfaceHandoffs(s.data) {
		if (turn == "" || cp.Turn == turn) && interfaceTerminal(s.data, cp.Call).ID == "" {
			if err := h.settleInterfaceUnknownLocked(s, cp, reason); err != nil {
				return err
			}
		}
	}
	h.armInterfaceTimerLocked(s)
	return nil
}

func (h *Harness) recoverInterfaceLocked(s *session) error {
	for _, cp := range api.InterfaceHandoffs(s.data) {
		if interfaceTerminal(s.data, cp.Call).ID != "" {
			continue
		}
		_, saved, valid := h.restoreInterface(s.data, cp)
		if !valid || saved.Deadline <= worktime.Now().UnixMilli() || interfaceTurnFailed(s.data, cp.Turn) {
			if err := h.settleInterfaceUnknownLocked(s, cp, "Interface call expired or its handoff could not be restored; outcome unknown."); err != nil {
				return err
			}
		}
	}
	h.armInterfaceTimerLocked(s)
	return nil
}

func (h *Harness) armInterfaceTimerLocked(s *session) {
	if s.interfaceTimer != nil {
		s.interfaceTimer.Stop()
		s.interfaceTimer = nil
	}
	if s.closing || s.writerFailure != nil {
		return
	}
	var next int64
	for _, cp := range api.InterfaceHandoffs(s.data) {
		if interfaceTerminal(s.data, cp.Call).ID != "" {
			continue
		}
		end := api.Decode[api.InterfaceHandoff](cp.Data).Deadline
		if end > 0 && (next == 0 || end < next) {
			next = end
		}
	}
	if next == 0 {
		return
	}
	var timer worktime.Timer
	timer = worktime.At(time.UnixMilli(next), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.interfaceTimer != timer || s.closing || s.writerFailure != nil {
			return
		}
		if s.reconcileErasureLocked() != nil || h.recoverInterfaceLocked(s) != nil {
			return
		}
		h.startInterfaceContinuationsLocked(s)
	})
	s.interfaceTimer = timer
}

func (p *turnPorts) recordInterfaceTurnEnd(ctx context.Context, e api.Entry) (api.Entry, error) {
	s := p.s
	s.mu.Lock()
	if err := s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return e, err
	}
	out := api.Decode[api.Outcome](e.Data)
	for id, cp := range api.InterfaceHandoffs(s.data) {
		if cp.Turn != p.id || interfaceTerminal(s.data, id).ID != "" {
			continue
		}
		_, saved, valid := p.c.h.restoreInterface(s.data, cp)
		if out.Status != "completed" || !valid || saved.Deadline <= worktime.Now().UnixMilli() {
			if err := p.c.h.settleInterfaceUnknownLocked(s, cp, "Turn ended without a confirmed Interface tool outcome."); err != nil {
				s.mu.Unlock()
				return e, err
			}
		}
	}
	out.Open = slices.DeleteFunc(slices.Clone(out.Open), func(c api.Call) bool { return interfaceTerminal(s.data, c.ID).ID != "" })
	e.Data = api.JSON(out)
	e, err := s.recordLocked(e, p.c.owner, true, ctx)
	p.c.h.armInterfaceTimerLocked(s)
	s.mu.Unlock()
	if err == nil {
		p.Emit(ctx, api.Event{Kind: "history.added", Data: api.JSON(e)})
	}
	return e, err
}
