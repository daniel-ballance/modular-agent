package modular

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

// ToolSource provides the current registrations. Per-session sources receive
// an empty session ID when the host asks for their initial shared list.
type ToolSource struct {
	ID         string
	PerSession bool
	Tools      func(sessionID string) []Tool
	Changes    *ToolChanges
}

// ToolChanges notifies each active served instance. Pass the handler's context
// for a change it made so the host refreshes before accepting its reply.
type ToolChanges struct {
	mu        sync.Mutex
	next      uint64
	listeners map[uint64]func(context.Context) error
}

func (c *ToolChanges) Changed(ctx ...context.Context) error {
	if len(ctx) > 1 {
		return &Error{Code: InvalidRequest, Message: "expected at most one change context"}
	}
	call := context.Background()
	if len(ctx) == 1 {
		call = ctx[0]
	}
	c.mu.Lock()
	listeners := make([]func(context.Context) error, 0, len(c.listeners))
	for _, f := range c.listeners {
		listeners = append(listeners, f)
	}
	c.mu.Unlock()
	var err error
	for _, f := range listeners {
		err = errors.Join(err, f(call))
	}
	return err
}
func (c *ToolChanges) subscribe(f func(context.Context) error) func() {
	c.mu.Lock()
	if c.listeners == nil {
		c.listeners = map[uint64]func(context.Context) error{}
	}
	c.next++
	n := c.next
	c.listeners[n] = f
	c.mu.Unlock()
	return func() { c.mu.Lock(); delete(c.listeners, n); c.mu.Unlock() }
}

func (r *Registrar) Tools(source ToolSource) error {
	if source.ID == "" || source.ID == "tools" || strings.ContainsAny(source.ID, " \t\r\n/:") || source.Tools == nil {
		return r.fail(fmt.Errorf("invalid tool source %q", source.ID))
	}
	if err := r.add("source:" + source.ID); err != nil {
		return err
	}
	initial := map[string]bool{}
	for _, t := range source.Tools("") {
		name := t.definition.Name
		if t.invalid != nil || t.run == nil || initial[name] {
			return r.fail(fmt.Errorf("invalid tool %q in source %q", name, source.ID))
		}
		initial[name] = true
	}
	r.sources = append(r.sources, source)
	return nil
}

func bindToolChanges(server *pluginrpc.Server, source ToolSource) func() {
	if source.Changes == nil {
		return func() {}
	}
	return source.Changes.subscribe(func(ctx context.Context) error { return server.ToolsChanged(ctx, source.ID) })
}
