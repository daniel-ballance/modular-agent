package harness

import (
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"slices"
)

type outputListener struct {
	recipient func(api.Event) string
	deliver   func(api.Event)
}

func (c *client) Subscribe(fn func(api.Event)) func() {
	return c.SubscribeOutput(func(api.Event) string { return "interface" }, fn)
}

// SubscribeOutput names recipients individually so one output handler's
// answer for a recipient is never used for another recipient.
func (c *client) SubscribeOutput(recipient func(api.Event) string, fn func(api.Event)) func() {
	c.h.mu.Lock()
	n := c.h.nextListener
	c.h.nextListener++
	c.h.listeners[n] = outputListener{recipient, fn}
	c.h.mu.Unlock()
	return func() { c.h.mu.Lock(); delete(c.h.listeners, n); c.h.mu.Unlock() }
}

func (c *client) deliverOutput(ctx context.Context, final api.Event, events []api.Event) {
	c.h.mu.RLock()
	listeners := make([]outputListener, 0, len(c.h.listeners))
	for _, listener := range c.h.listeners {
		listeners = append(listeners, listener)
	}
	c.h.mu.RUnlock()
	perRecipient := map[string][]api.Event{}
	for _, listener := range listeners {
		func() {
			defer func() { _ = recover() }()
			// The recipient selector sees identities only, not ungated content.
			recipient := listener.recipient(api.Event{Kind: final.Kind, Session: final.Session})
			if recipient == "" {
				return
			}
			gated, found := perRecipient[recipient]
			if !found {
				gated, _ = c.gateBatch(ctx, final.Session, recipient, clone(events))
				// Some Interfaces use the end marker to replay a response if the
				// model never streamed it. Do not trigger that fallback if the
				// gate deliberately removed the visible pieces of a stream.
				if final.Kind == "model.stream.end" && slices.ContainsFunc(events, visibleDelta) &&
					!slices.ContainsFunc(gated, visibleDelta) {
					gated = slices.DeleteFunc(slices.Clone(gated), func(e api.Event) bool {
						return e.Kind == "model.stream.end"
					})
				}
				perRecipient[recipient] = gated
			}
			for _, event := range gated {
				listener.deliver(clone(event))
			}
		}()
	}
}

func visibleDelta(e api.Event) bool {
	if e.Kind != "model.delta" {
		return false
	}
	part := api.Decode[api.Part](e.Data)
	return part.Type == "text" || part.Type == "reasoning"
}

type outputStream struct {
	session, turn, id, kind string
}

func (c *client) HoldsOutput() bool {
	c.h.mu.RLock()
	defer c.h.mu.RUnlock()
	return len(c.h.hooks["output.batch"].handlers) != 0
}

func (c *client) output(ctx context.Context, e api.Event) (api.Output, error) {
	switch e.Kind {
	case "history.added":
		e.Data = api.JSON(portable.PublicEntry(api.Decode[api.Entry](e.Data)))
	case "model.delta":
		if p := api.Decode[api.Part](e.Data); p.Type == "reasoning" {
			if parts := portable.PublicContent(api.Content{p}); len(parts) != 0 {
				e.Data = api.JSON(parts[0])
			} else {
				return api.Output{Event: e, Hold: true}, nil
			}
		}
	}
	v, err := c.h.API().Invoke(ctx, "output", api.Output{Event: e})
	if err != nil {
		return api.Output{}, err
	}
	return v.(api.Output), nil
}

func (c *client) gateBatch(ctx context.Context, session, recipient string, events []api.Event) ([]api.Event, error) {
	if recipient == "" {
		recipient = "interface"
	}
	v, err := c.h.API().Invoke(ctx, "output.batch", api.OutputBatch{Session: session, Recipient: recipient, Events: events})
	if err != nil {
		return nil, err
	}
	return v.(api.OutputBatch).Events, nil
}

// OutputValue gates a non-stream Interface response once, without publishing it.
func (c *client) OutputValue(ctx context.Context, e api.Event) (api.Event, error) {
	out, err := c.output(ctx, e)
	if err != nil {
		return api.Event{}, fmt.Errorf("%w: %w", api.ErrOutputWithheld, err)
	}
	if out.Hold {
		return api.Event{}, api.ErrOutputWithheld
	}
	events, err := c.gateBatch(ctx, e.Session, api.Acting(ctx), []api.Event{out.Event})
	if err != nil {
		return api.Event{}, fmt.Errorf("%w: %w", api.ErrOutputWithheld, err)
	}
	if len(events) != 1 || events[0].Kind != e.Kind {
		return api.Event{}, api.ErrOutputWithheld
	}
	return events[0], nil
}

// streamOutput keeps model deltas and tool progress until their end markers.
// The raw ledger and the local, piece-oriented gate are not changed.
func (c *client) streamOutput(e api.Event, held bool) []api.Event {
	if !c.HoldsOutput() {
		if held {
			return nil
		}
		return []api.Event{e}
	}
	var key outputStream
	final := false
	switch e.Kind {
	case "model.delta", "model.stream.end":
		key = outputStream{e.Session, e.Turn, e.Step, "model"}
		final = e.Kind == "model.stream.end"
	case "tool.progress", "tool.end":
		key = outputStream{e.Session, e.Turn, e.Call, "tool"}
		final = e.Kind == "tool.end"
	}
	if key.kind == "" {
		if held {
			return nil
		}
		return []api.Event{e}
	}
	c.h.outputMu.Lock()
	if !held {
		c.h.outputStreams[key] = append(c.h.outputStreams[key], e)
	}
	if !final {
		c.h.outputMu.Unlock()
		return nil
	}
	events := c.h.outputStreams[key]
	delete(c.h.outputStreams, key)
	c.h.outputMu.Unlock()
	return events
}
