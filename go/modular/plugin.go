package modular

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/pluginrpc"
	"github.com/OWNER/modular-agent/go/portable"
)

type Plugin struct {
	Name     string
	Replaces []string
	Config   map[string]any
	Setup    func(*Registrar) error
	Stop     func() error
}
type Order string

const (
	First  Order = "first"
	Normal Order = "normal"
	Last   Order = "last"
)

type HookOption func(*hookRegistration)

func HookOrder(order Order) HookOption { return func(h *hookRegistration) { h.order = order } }
func HookInProcessOnly() HookOption    { return func(h *hookRegistration) { h.only = true } }

type hookRegistration struct {
	point  string
	order  Order
	only   bool
	handle func(context.Context, pluginrpc.Object) (any, error)
}
type CommandContext struct{ SessionID, ActorID string }
type Command struct {
	Name, Description        string
	Run                      func(context.Context, string, *CommandContext) (string, error)
	InProcessOnly, UsesModel bool
}
type Registrar struct {
	config    map[string]any
	tools     []Tool
	hooks     []hookRegistration
	commands  []Command
	providers []Provider
	items     map[string]bool
	stopped   bool
	err       error
}

func (r *Registrar) Config() map[string]any {
	var config map[string]any
	_ = decodeInto(r.config, &config)
	return config
}
func (r *Registrar) add(item string) error {
	if r.stopped || r.items[item] {
		return r.fail(fmt.Errorf("duplicate or late registration %s", item))
	}
	r.items[item] = true
	return nil
}
func (r *Registrar) fail(err error) error {
	if r.err == nil {
		r.err = err
	}
	return err
}
func (r *Registrar) Tool(t Tool) error {
	if t.invalid != nil {
		return r.fail(t.invalid)
	}
	if t.run == nil {
		return r.fail(fmt.Errorf("missing tool function"))
	}
	for _, c := range t.definition.Callers {
		if c != "model" && c != "ui" && c != "plugin" {
			return r.fail(fmt.Errorf("invalid tool caller %q", c))
		}
	}
	if err := r.add("tool:" + t.definition.Name); err != nil {
		return err
	}
	r.tools = append(r.tools, t)
	return nil
}
func (r *Registrar) Provider(p Provider) error {
	if p.ID == "" || strings.Contains(p.ID, "/") || p.Models == nil || p.Request == nil {
		return r.fail(fmt.Errorf("provider needs a valid id, catalog and request function"))
	}
	seen := map[string]bool{}
	for _, m := range p.Models() {
		if m.ID == "" || seen[m.ID] || m.Provider != "" && m.Provider != p.ID {
			return r.fail(fmt.Errorf("invalid model identity %s", m.ID))
		}
		seen[m.ID] = true
	}
	if err := r.add("provider:" + p.ID); err != nil {
		return err
	}
	r.providers = append(r.providers, p)
	return nil
}
func (r *Registrar) Command(c Command) error {
	if c.Name == "" || strings.ContainsAny(c.Name, "/ \t\r\n") || c.Description == "" || c.Run == nil {
		return r.fail(fmt.Errorf("invalid command %q", c.Name))
	}
	if err := r.add("command:" + c.Name); err != nil {
		return err
	}
	r.commands = append(r.commands, c)
	return nil
}
func (r *Registrar) on(h hookRegistration, opts []HookOption) error {
	if r.stopped {
		return r.fail(fmt.Errorf("late hook registration"))
	}
	h.order = Normal
	for _, opt := range opts {
		opt(&h)
	}
	if !slices.Contains([]Order{First, Normal, Last}, h.order) {
		return r.fail(fmt.Errorf("invalid hook order"))
	}
	r.hooks = append(r.hooks, h)
	return nil
}

type ToolBefore struct {
	SessionID  string         `json:"sessionId"`
	TurnID     string         `json:"turnId"`
	Call       ToolCall       `json:"call"`
	Definition ToolDefinition `json:"definition"`
}
type Gate struct {
	Refuse string
	Input  json.RawMessage
}

func (r *Registrar) OnToolBefore(fn func(context.Context, ToolBefore) (Gate, error), opts ...HookOption) error {
	return r.on(hookRegistration{point: "tool.before", handle: func(ctx context.Context, p pluginrpc.Object) (any, error) {
		var in ToolBefore
		if err := decodeInto(p, &in); err != nil {
			return nil, err
		}
		g, err := fn(ctx, in)
		if err != nil {
			return nil, err
		}
		if g.Refuse != "" {
			return pluginrpc.Object{"refuse": g.Refuse}, nil
		}
		if g.Input != nil {
			in.Call.Input = g.Input
			return pluginrpc.Object{"change": pluginrpc.Object{"call": in.Call}}, nil
		}
		return nil, nil
	}}, opts)
}

type ToolAfter struct {
	SessionID string     `json:"sessionId"`
	TurnID    string     `json:"turnId"`
	Call      ToolCall   `json:"call"`
	Result    ToolResult `json:"result"`
}
type ToolChange struct {
	Content *Content
	Value   json.RawMessage
}

func (r *Registrar) OnToolAfter(fn func(context.Context, ToolAfter) (ToolChange, error), opts ...HookOption) error {
	return r.on(hookRegistration{point: "tool.after", handle: func(ctx context.Context, p pluginrpc.Object) (any, error) {
		var in ToolAfter
		if err := decodeInto(p, &in); err != nil {
			return nil, err
		}
		c, err := fn(ctx, in)
		if err != nil {
			return nil, err
		}
		if c.Content == nil && c.Value == nil {
			return nil, nil
		}
		var result pluginrpc.Object
		if err := decodeInto(p["result"], &result); err != nil {
			return nil, err
		}
		if c.Content != nil {
			result["content"] = *c.Content
		}
		if c.Value != nil {
			result["value"] = c.Value
		}
		changed := maps.Clone(p)
		changed["result"] = result
		return pluginrpc.Object{"value": changed}, nil
	}}, opts)
}

type TurnBefore struct {
	SessionID string  `json:"sessionId"`
	TurnID    string  `json:"turnId"`
	Input     Content `json:"input"`
}
type TurnContribution struct {
	System  string  `json:"system,omitempty"`
	Context Content `json:"context,omitempty"`
}

func (r *Registrar) OnTurnBefore(fn func(context.Context, TurnBefore) (TurnContribution, error), opts ...HookOption) error {
	return r.on(hookRegistration{point: "turn.before", handle: func(ctx context.Context, p pluginrpc.Object) (any, error) {
		var in TurnBefore
		if err := decodeInto(p, &in); err != nil {
			return nil, err
		}
		return fn(ctx, in)
	}}, opts)
}

type StepAfter struct {
	SessionID string           `json:"sessionId"`
	TurnID    string           `json:"turnId"`
	StepID    string           `json:"stepId"`
	Response  AssistantMessage `json:"response"`
}
type StepDecision struct{ End string }

func (r *Registrar) OnStepAfter(fn func(context.Context, StepAfter) (StepDecision, error), opts ...HookOption) error {
	return r.on(hookRegistration{point: "step.after", handle: func(ctx context.Context, p pluginrpc.Object) (any, error) {
		var in StepAfter
		if err := decodeInto(p, &in); err != nil {
			return nil, err
		}
		d, err := fn(ctx, in)
		if err != nil || d.End == "" {
			return nil, err
		}
		return pluginrpc.Object{"refuse": d.End}, nil
	}}, opts)
}

type TurnEnd struct {
	SessionID string  `json:"sessionId"`
	TurnID    string  `json:"turnId"`
	Outcome   Outcome `json:"outcome"`
}

func (r *Registrar) OnTurnEnd(fn func(context.Context, TurnEnd) error, opts ...HookOption) error {
	return r.on(hookRegistration{point: "turn.end", handle: func(ctx context.Context, p pluginrpc.Object) (any, error) {
		var in TurnEnd
		if err := decodeInto(p, &in); err != nil {
			return nil, err
		}
		return nil, fn(ctx, in)
	}}, opts)
}

func register(p Plugin, config map[string]any) (*Registrar, error) {
	if p.Name == "" {
		return nil, &Error{Code: InvalidComposition, Message: "plugin name is empty"}
	}
	r := &Registrar{config: config, items: map[string]bool{}}
	if p.Setup != nil {
		if err := p.Setup(r); err != nil {
			return nil, err
		}
	}
	r.stopped = true
	if r.err != nil {
		return nil, r.err
	}
	seen := map[string]bool{}
	for _, item := range p.Replaces {
		if seen[item] || !r.items[item] {
			return nil, fmt.Errorf("%s: invalid replacement %q", p.Name, item)
		}
		seen[item] = true
	}
	return r, nil
}
func loadPlugin(h *harness.Harness, p Plugin) error {
	r, err := register(p, p.Config)
	if err != nil {
		if p.Stop != nil {
			_ = p.Stop()
		}
		return err
	}
	err = h.LoadItems(api.Plugin{Name: p.Name, Close: p.Stop, Setup: func(a api.API) error {
		if len(r.tools) > 0 {
			if err := a.Provide("tools.sdk."+p.Name, &toolSource{a: a, tools: r.tools}); err != nil {
				return err
			}
		}
		for _, p := range r.providers {
			if err := a.Provide("provider."+p.ID, providerAdapter{p}); err != nil {
				return err
			}
		}
		for _, c := range r.commands {
			if err := a.RegisterCommand(c.Name, func(ctx context.Context, s string, args []string) (string, error) {
				return c.Run(ctx, strings.Join(args, " "), &CommandContext{SessionID: s, ActorID: api.Acting(ctx)})
			}); err != nil {
				return err
			}
		}
		for _, hook := range r.hooks {
			order := string(hook.order)
			if hook.order == Normal {
				order = ""
			}
			if hook.point == "turn.before" {
				if err := a.Handle("turn.prepare", order, func(ctx context.Context, v any) (api.Decision, error) {
					before := v.(api.BeforeTurn)
					result, err := hook.handle(ctx, pluginrpc.Object{"sessionId": before.Session.ID, "turnId": before.Turn, "input": portable.Content(before.Input)})
					if err != nil {
						return api.Decision{}, err
					}
					add := result.(TurnContribution)
					if add.System != "" {
						before.System += "\n" + add.System
					}
					before.Context = append(before.Context, portable.ReadContent(add.Context)...)
					return api.Decision{Value: before}, nil
				}); err != nil {
					return err
				}
			} else if err := pluginrpc.RegisterLocalHook(a, hook.point, order, hook.handle); err != nil {
				return err
			}
		}
		return nil
	}}, p.Replaces)
	if err != nil && p.Stop != nil {
		_ = p.Stop()
	}
	return err
}
