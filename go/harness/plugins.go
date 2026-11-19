// Package harness hosts plugins and open sessions. It contains no agent loop.
package harness

import (
	"context"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
	"sort"
	"strings"
	"sync"
)

type registration struct {
	owner string
	value any
}
type hook struct {
	owner     string
	rule      api.Rule
	handlers  []handler
	rebinding bool
}
type handler struct {
	owner string
	order int
	fn    api.Handler
}
type Harness struct {
	localActor      string
	handBackOnOpen  bool
	parkJobReports  bool
	refuseSettings  bool
	inTurnQuestions bool
	tenants         map[string]tenantConfig
	tenantConfigErr error
	mu              sync.RWMutex
	plugins         map[string]api.Plugin
	external        map[string]bool
	externalPlugins map[string]bool
	order           []string
	caps            map[string]registration
	hooks           map[string]*hook
	commands        map[string]registration
	sessions        map[string]*session
	projectGate     sync.Mutex        // serializes session registration with rewind
	blockedProjects map[string]string // canonical project -> session with unresolved rewind
	checkedProjects map[string]bool   // initial journal scan done
	listeners       map[int]outputListener
	nextListener    int
	outputMu        sync.Mutex
	outputStreams   map[outputStream][]api.Event
}
type client struct {
	h     *Harness
	owner string
}

func New() *Harness { return NewWithLocalActor("local-user") }

// NewWithLocalActor sets the principal for new embedded sessions.
func NewWithLocalActor(actor string) *Harness {
	h := &Harness{external: map[string]bool{}, externalPlugins: map[string]bool{}, plugins: map[string]api.Plugin{}, caps: map[string]registration{}, hooks: map[string]*hook{}, commands: map[string]registration{}, sessions: map[string]*session{}, listeners: map[int]outputListener{}, outputStreams: map[outputStream][]api.Event{}}
	h.localActor = actor
	h.tenants, h.tenantConfigErr = readTenants()
	for name, rule := range map[string]api.Rule{"plugin.load": api.Gate, "process.stop": api.Observe, "session.prepare": api.Observe, "session.start": api.Observe, "session.ready": api.Observe, "session.stop": api.Observe, "session.end": api.Observe, "session.fork": api.Transform, "input": api.Transform, "turn.prepare": api.Transform, "output": api.Transform, "output.batch": api.Gate} {
		h.hooks[name] = &hook{owner: "harness", rule: rule}
	}
	return h
}

// HandBackQueuedOnOpen selects the embedded SDK's recovery policy before loading plugins.
func (h *Harness) HandBackQueuedOnOpen() { h.handBackOnOpen = true }

// ConfigureSessions sets SDK policies before plugins or sessions are loaded.
func (h *Harness) ConfigureSessions(jobReportsStartTurns, lateQuestions, refuseSettings bool) {
	h.parkJobReports = !jobReportsStartTurns
	h.inTurnQuestions = !lateQuestions
	h.refuseSettings = refuseSettings
}

func (c *client) LateQuestions() bool { return !c.h.inTurnQuestions }

// QueuedRecoveryPolicy reports the policy used when installing recovered work.
func (h *Harness) QueuedRecoveryPolicy() (inputs, jobReports string) {
	if h.handBackOnOpen {
		if h.parkJobReports {
			return "handedBack", "handedBack"
		}
		return "handedBack", "run"
	}
	return "run", "run"
}

func (h *Harness) API() api.API     { return &client{h: h, owner: "harness"} }
func (c *client) validLocked() bool { _, ok := c.h.plugins[c.owner]; return c.owner == "harness" || ok }
func (h *Harness) Load(p api.Plugin) error {
	if p.Name == "" || p.Name == "harness" || p.Setup == nil {
		return errors.New("invalid plugin")
	}
	if _, err := h.API().Invoke(context.Background(), "plugin.load", p.Name); err != nil {
		return err
	}
	h.mu.Lock()
	if len(h.sessions) > 0 {
		h.mu.Unlock()
		return errors.New("plugins are fixed while sessions are open")
	}
	if _, ok := h.plugins[p.Name]; ok {
		h.mu.Unlock()
		return errors.New("duplicate plugin")
	}
	if p.Replaces != "" {
		old, ok := h.plugins[p.Replaces]
		if !ok {
			h.mu.Unlock()
			return errors.New("replacement target missing")
		}
		h.mu.Unlock()
		if old.Close != nil {
			if err := old.Close(); err != nil {
				return err
			}
		}
		h.mu.Lock()
		retained := map[string]*hook{}
		for name, point := range h.hooks {
			if point.owner == p.Replaces {
				copy := *point
				copy.handlers = nil
				for _, handler := range point.handlers {
					if handler.owner != p.Replaces {
						copy.handlers = append(copy.handlers, handler)
					}
				}
				copy.owner, copy.rebinding = p.Name, true
				retained[name] = &copy
			}
		}
		h.removeLocked(p.Replaces)
		for name, point := range retained {
			h.hooks[name] = point
		}
	}
	h.plugins[p.Name] = p
	h.order = append(h.order, p.Name)
	h.mu.Unlock()
	if err := p.Setup(&client{h: h, owner: p.Name}); err != nil {
		h.mu.Lock()
		h.removeLocked(p.Name)
		h.mu.Unlock()
		if p.Close != nil {
			_ = p.Close()
		}
		return err
	}
	h.mu.Lock()
	for name, point := range h.hooks {
		if point.owner == p.Name && point.rebinding {
			delete(h.hooks, name)
		}
	}
	h.mu.Unlock()
	return nil
}
func (h *Harness) removeLocked(name string) {
	delete(h.plugins, name)
	for i, n := range h.order {
		if n == name {
			h.order = append(h.order[:i], h.order[i+1:]...)
			break
		}
	}
	for k, r := range h.caps {
		if r.owner == name {
			delete(h.caps, k)
		}
	}
	for k, r := range h.commands {
		if r.owner == name {
			delete(h.commands, k)
		}
	}
	for k, p := range h.hooks {
		if p.owner == name {
			delete(h.hooks, k)
			continue
		}
		kept := p.handlers[:0]
		for _, v := range p.handlers {
			if v.owner != name {
				kept = append(kept, v)
			}
		}
		p.handlers = kept
	}
}
func (c *client) Provide(name string, v any) error {
	c.h.mu.Lock()
	defer c.h.mu.Unlock()
	if !c.validLocked() {
		return errors.New("inactive plugin")
	}
	if _, ok := c.h.caps[name]; ok {
		return fmt.Errorf("duplicate capability %s", name)
	}
	c.h.caps[name] = registration{c.owner, v}
	return nil
}
func (c *client) Get(name string) (any, error) {
	c.h.mu.RLock()
	defer c.h.mu.RUnlock()
	if !c.validLocked() {
		return nil, errors.New("inactive plugin")
	}
	r, ok := c.h.caps[name]
	if !ok {
		return nil, fmt.Errorf("missing capability %s", name)
	}
	return r.value, nil
}
func (c *client) All(prefix string) []any {
	c.h.mu.RLock()
	defer c.h.mu.RUnlock()
	var out []any
	for _, owner := range c.h.order {
		var keys []string
		for key, r := range c.h.caps {
			if r.owner == owner && strings.HasPrefix(key, prefix) {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			out = append(out, c.h.caps[key].value)
		}
	}
	return out
}
func (c *client) Define(name string, rule api.Rule) error {
	c.h.mu.Lock()
	defer c.h.mu.Unlock()
	if !c.validLocked() {
		return errors.New("inactive plugin")
	}
	switch rule {
	case api.Observe, api.Gate, api.Transform, api.FirstAnswer, api.Collect:
	default:
		return errors.New("invalid hook rule")
	}
	if existing, ok := c.h.hooks[name]; ok {
		if existing.owner == c.owner && existing.rebinding && existing.rule == rule {
			existing.rebinding = false
			return nil
		}
		return errors.New("duplicate hook or incompatible replacement rule")
	}
	c.h.hooks[name] = &hook{owner: c.owner, rule: rule}
	return nil
}
func (c *client) Handle(name, order string, fn api.Handler) error {
	c.h.mu.Lock()
	defer c.h.mu.Unlock()
	if !c.validLocked() {
		return errors.New("inactive plugin")
	}
	point, ok := c.h.hooks[name]
	if !ok {
		return fmt.Errorf("missing hook %s", name)
	}
	n := 0
	switch order {
	case "first":
		n = -1
	case "last":
		n = 1
	case "":
	default:
		return errors.New("invalid hook order")
	}
	point.handlers = append(point.handlers, handler{c.owner, n, fn})
	sort.SliceStable(point.handlers, func(i, j int) bool { return point.handlers[i].order < point.handlers[j].order })
	return nil
}
func (c *client) Invoke(ctx context.Context, name string, v any) (any, error) {
	c.h.mu.RLock()
	point, ok := c.h.hooks[name]
	if !c.validLocked() || !ok || point.owner != c.owner {
		c.h.mu.RUnlock()
		return nil, fmt.Errorf("hook %s not owned by %s", name, c.owner)
	}
	handlers := append([]handler(nil), point.handlers...)
	rule := point.rule
	c.h.mu.RUnlock()
	var collected []any
	for _, h := range handlers {
		d, err := safeHandle(ctx, h.fn, v)
		if rule == api.Observe {
			if err != nil {
				c.h.API().Emit(ctx, api.Event{Kind: "plugin.problem", Data: api.JSON(map[string]string{"where": name, "plugin": h.owner, "message": err.Error()})})
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		switch rule {
		case api.Gate:
			if d.Refuse {
				return nil, errors.New("hook refused operation")
			}
			if d.Value != nil {
				if before, ok := v.(api.ToolCheck); ok && before.Call.ParentCall != "" {
					after, ok := d.Value.(api.ToolCheck)
					a, b := before.Call, after.Call
					if !ok || a.ID != b.ID || a.Name != b.Name || a.Actor != b.Actor || a.Origin != b.Origin || a.ParentCall != b.ParentCall || a.Step != b.Step {
						return nil, errors.New("tool gate changed protected call fields")
					}
					after.InputChanged = before.InputChanged || !portable.EqualJSON(a.Input, b.Input)
					d.Value = after
				}
				v = d.Value
			}
			// Only refusal can short-circuit a gate. Allow cannot bypass a later guard.
		case api.Transform:
			if d.Value != nil {
				v = d.Value
			}
			if d.Stop {
				return v, nil
			}
		case api.FirstAnswer:
			if d.Answer {
				return d.Value, nil
			}
		case api.Collect:
			if d.Value != nil {
				collected = append(collected, d.Value)
			}
		}
	}
	if rule == api.Collect {
		return collected, nil
	}
	return v, nil
}
func safeHandle(ctx context.Context, fn api.Handler, v any) (d api.Decision, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("hook panic: %v", p)
		}
	}()
	return fn(ctx, v)
}
func (c *client) RegisterCommand(name string, fn api.Command) error {
	c.h.mu.Lock()
	defer c.h.mu.Unlock()
	if !c.validLocked() {
		return errors.New("inactive plugin")
	}
	if _, ok := c.h.commands[name]; ok {
		return errors.New("duplicate command")
	}
	c.h.commands[name] = registration{c.owner, fn}
	return nil
}
func (c *client) Commands() []string {
	c.h.mu.RLock()
	defer c.h.mu.RUnlock()
	var out []string
	for k := range c.h.commands {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
func (c *client) Command(ctx context.Context, id, line string) (string, error) {
	s, err := c.find(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if !c.authorized(s.data, api.Acting(ctx), "input") {
		s.mu.Unlock()
		return "", errors.New("command authority refused")
	}
	if s.rewindBlocked {
		s.mu.Unlock()
		return "", errRewindUnresolved
	}
	if s.closing {
		s.mu.Unlock()
		return "", errors.New("session is closing")
	}
	s.commands++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.commands--
		s.mu.Unlock()
	}()
	fields := strings.Fields(strings.TrimPrefix(line, "/"))
	if len(fields) == 0 {
		return "", errors.New("empty command")
	}
	c.h.mu.RLock()
	r, ok := c.h.commands[fields[0]]
	c.h.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("unknown command /%s", fields[0])
	}
	result, err := r.value.(api.Command)(ctx, id, fields[1:])
	if err != nil {
		return "", err
	}
	out, err := c.OutputValue(ctx, api.Event{Kind: "command.result", Session: id, Data: api.JSON(result)})
	if err != nil {
		return "", err
	}
	return api.Decode[string](out.Data), nil
}
func (h *Harness) Close() error {
	h.mu.RLock()
	var ids []string
	var sessions []*session
	for id, s := range h.sessions {
		ids = append(ids, id)
		sessions = append(sessions, s)
	}
	h.mu.RUnlock()
	// Refuse new intake before job shutdown, but interrupt jobs before their
	// child turns so a stopped child is never mistaken for a finished job.
	for _, s := range sessions {
		s.mu.Lock()
		s.closing = true
		s.mu.Unlock()
	}
	_, _ = h.API().Invoke(context.Background(), "process.stop", nil)
	var errs []error
	for _, id := range ids {
		if _, err := h.API().(*client).find(id); err != nil {
			continue
		}
		errs = append(errs, h.API().(*client).stopSession(id, false))
	}
	h.mu.RLock()
	order := append([]string(nil), h.order...)
	h.mu.RUnlock()
	for i := len(order) - 1; i >= 0; i-- {
		h.mu.RLock()
		p := h.plugins[order[i]]
		h.mu.RUnlock()
		if p.Close != nil {
			errs = append(errs, p.Close())
		}
	}
	return errors.Join(errs...)
}
