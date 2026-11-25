package harness

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"slices"
	"strings"
	"time"
)

type outputListener struct {
	recipient func(api.Event) string
	deliver   func(api.Event)
}

func (c *client) View(ctx context.Context, id string) (api.Session, error) {
	return c.view(ctx, id, true)
}

// ViewForOutput applies the native view policy before the Interface shapes
// the entries or reply that the remote gate will see.
func (c *client) ViewForOutput(ctx context.Context, id string) (api.Session, error) {
	return c.view(ctx, id, false)
}

func (c *client) view(ctx context.Context, id string, gateRemote bool) (api.Session, error) {
	if !api.ConnectionAllows(ctx, "watch") || !c.Authorize(id, api.Acting(ctx), "watch") {
		return api.Session{}, errors.New("watch refused")
	}
	epoch, err := c.ErasureEpoch(id)
	if err != nil {
		return api.Session{}, err
	}
	snap, err := c.Snapshot(id)
	if err != nil {
		return snap, err
	}
	for i, entry := range snap.Entries {
		snap.Entries[i] = portable.PublicEntry(entry)
	}
	event := api.Event{Kind: "history.view", Session: id, Data: api.JSON(snap)}
	if gateRemote {
		out, err := c.OutputValue(ctx, event)
		if err != nil {
			return api.Session{}, err
		}
		if got, err := c.ErasureEpoch(id); err != nil || got != epoch {
			return api.Session{}, api.ErrErasureUnavailable
		}
		return api.Decode[api.Session](out.Data), nil
	}
	out, err := c.output(ctx, event)
	if err != nil || out.Hold {
		return api.Session{}, api.ErrOutputWithheld
	}
	if got, err := c.ErasureEpoch(id); err != nil || got != epoch {
		return api.Session{}, api.ErrErasureUnavailable
	}
	return api.Decode[api.Session](out.Event.Data), nil
}

func (c *client) Emit(ctx context.Context, e api.Event) {
	// A listener cannot change execution.
	defer func() { _ = recover() }()
	if epoch, err := c.ErasureEpoch(e.Session); err != nil {
		return
	} else {
		e.ErasureEpoch = epoch
	}
	e.Time = time.Now().UTC()
	boundary := e
	out, err := c.output(ctx, e)
	if err == nil && !out.Hold {
		if strings.HasPrefix(e.Kind, "plugin.") && !bytes.Equal(e.Data, out.Event.Data) {
			out.Event.OutputChanged = true
		}
		out.Event.ErasureEpoch = e.ErasureEpoch
		e = out.Event
	}
	events, release, deliver := c.streamOutput(boundary, e, err != nil || out.Hold)
	defer release()
	if deliver {
		c.deliverOutput(ctx, boundary, events)
	}
}

func (p *turnPorts) Emit(ctx context.Context, e api.Event) {
	e.Session = p.s.id
	e.Turn = p.id
	e.Actor = p.actor
	p.c.Emit(ctx, e)
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
	var charges []func()
	defer func() {
		for _, release := range charges {
			release()
		}
	}()
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
				if events == nil {
					gated = []api.Event{overflowNotice(final)}
				} else {
					var err error
					var release func()
					gated, release, err = c.gateBatch(ctx, final.Session, recipient, events)
					charges = append(charges, release)
					if errors.Is(err, api.ErrOutputOverflow) && (final.Kind == "model.stream.end" || final.Kind == "tool.end") {
						gated = []api.Event{overflowNotice(final)}
					}
				}
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
				epoch, err := c.ErasureEpoch(final.Session)
				if err != nil || epoch != final.ErasureEpoch {
					return
				}
				view := event
				view.Data = slices.Clone(event.Data)
				if strings.HasPrefix(final.Kind, "plugin.") {
					view.OutputChanged = final.OutputChanged || !bytes.Equal(view.Data, final.Data)
				}
				view.ErasureEpoch = epoch
				listener.deliver(view)
			}
		}()
	}
}

func overflowNotice(final api.Event) api.Event {
	return api.Event{Kind: "output.overflow", Session: final.Session, Turn: final.Turn, Step: final.Step, Call: final.Call}
}

func cloneOutput(events []api.Event) []api.Event {
	out := slices.Clone(events)
	for i := range out {
		out[i].Data = slices.Clone(out[i].Data)
	}
	return out
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

// Keep every accepted segment private until the last gate has decided on the
// last segment. Registration is fixed while sessions are open.
func (c *client) gateBatch(ctx context.Context, session, recipient string, events []api.Event) ([]api.Event, func(), error) {
	c.h.mu.RLock()
	handlers := slices.Clone(c.h.hooks["output.batch"].handlers)
	c.h.mu.RUnlock()
	var charges []func()
	release := func() {
		for _, r := range charges {
			r()
		}
	}
	if len(handlers) == 0 {
		return events, release, nil
	}
	if recipient == "" {
		recipient = "interface"
	}
	var accepted []api.Event
	for start := 0; start < len(events); {
		end, size := start, 2
		for end < len(events) {
			n := len(api.JSON(portable.ProjectOutput(events[end])))
			if n+2 > portable.GateSegmentBytes {
				return nil, release, api.ErrOutputOverflow
			}
			if end > start && (size+1+n > portable.GateSegmentBytes || events[end].Kind == "model.stream.end" || events[end].Kind == "tool.end") {
				break
			}
			if end > start {
				size++
			}
			size += n
			end++
		}
		segment := events[start:end]
		charged := size
		for _, h := range handlers {
			d, err := safeHandle(ctx, h.fn, api.OutputBatch{Session: session, Recipient: recipient, Events: cloneOutput(segment)})
			if err != nil {
				return nil, release, err
			}
			if d.Refuse {
				return nil, release, api.ErrOutputWithheld
			}
			if d.Value == nil {
				continue
			}
			after, ok := d.Value.(api.OutputBatch)
			if !ok || len(after.Events) != len(segment) {
				return nil, release, api.ErrOutputWithheld
			}
			size = 2
			for i, v := range after.Events {
				before := segment[i]
				wire := portable.ProjectOutput(v)
				n := len(api.JSON(wire))
				if size+n > portable.GateSegmentBytes {
					return nil, release, api.ErrOutputOverflow
				}
				if v.Kind != before.Kind || v.Session != before.Session || v.Turn != before.Turn || v.Step != before.Step || v.Call != before.Call || !portable.ValidOutputEdit(portable.ProjectOutput(before), wire) {
					return nil, release, api.ErrOutputWithheld
				}
				after.Events[i].OutputChanged = before.OutputChanged || !portable.EqualJSON(before.Data, v.Data)
				if i > 0 {
					size++
				}
				size += n
			}
			if size > portable.GateSegmentBytes {
				return nil, release, api.ErrOutputOverflow
			}
			if size > charged {
				r := c.reserveOutputBytes(session, int64(size-charged))
				if r == nil {
					return nil, release, api.ErrOutputOverflow
				}
				charges = append(charges, r)
				charged = size
			}
			segment = after.Events
		}
		accepted = append(accepted, segment...)
		start = end
	}
	return accepted, release, nil
}

// OutputValue gates a non-stream Interface response once, without publishing it.
func (c *client) OutputValue(ctx context.Context, e api.Event) (api.Event, error) {
	return c.OutputValueFor(ctx, api.Acting(ctx), e)
}

// OutputValueFor separates a client-specific recipient from the authenticated actor.
func (c *client) OutputValueFor(ctx context.Context, recipient string, e api.Event) (api.Event, error) {
	epoch, err := c.ErasureEpoch(e.Session)
	if err != nil {
		return api.Event{}, err
	}
	out, err := c.output(ctx, e)
	if err != nil {
		return api.Event{}, fmt.Errorf("%w: %w", api.ErrOutputWithheld, err)
	}
	if out.Hold {
		return api.Event{}, api.ErrOutputWithheld
	}
	events, release, err := c.gateBatch(ctx, e.Session, recipient, []api.Event{out.Event})
	defer release()
	if err != nil {
		return api.Event{}, fmt.Errorf("%w: %w", api.ErrOutputWithheld, err)
	}
	if len(events) != 1 || events[0].Kind != e.Kind {
		return api.Event{}, api.ErrOutputWithheld
	}
	if current, err := c.ErasureEpoch(e.Session); err != nil || epoch != current {
		return api.Event{}, api.ErrErasureUnavailable
	}
	return events[0], nil
}

// streamOutput keeps model deltas and tool progress until their end markers.
// The raw ledger and the local, piece-oriented gate are not changed.
func (c *client) streamOutput(boundary, e api.Event, held bool) ([]api.Event, func(), bool) {
	nothing := func() {}
	if !c.HoldsOutput() {
		if held {
			return nil, nothing, false
		}
		buffered, ok := api.BufferEvent(c, e)
		if !ok {
			return nil, nothing, false
		}
		return []api.Event{e}, buffered.Release, true
	}
	var key outputStream
	final := false
	switch boundary.Kind {
	case "model.delta", "model.stream.end":
		key = outputStream{e.Session, e.Turn, e.Step, "model"}
		final = boundary.Kind == "model.stream.end"
	case "tool.progress", "tool.end":
		key = outputStream{e.Session, e.Turn, e.Call, "tool"}
		final = boundary.Kind == "tool.end"
	}
	if key.kind == "" {
		if held {
			return nil, nothing, false
		}
		buffered, ok := api.BufferEvent(c, e)
		if !ok {
			return nil, nothing, false
		}
		return []api.Event{e}, buffered.Release, true
	}
	c.h.outputMu.Lock()
	buffer := c.h.outputStreams[key]
	if buffer == nil {
		buffer = &heldStream{epoch: e.ErasureEpoch}
		c.h.outputStreams[key] = buffer
	}
	if buffer.epoch != e.ErasureEpoch {
		buffer.block()
	}
	if !held && !buffer.blocked {
		// Charge both the retained native event and its projected size when
		// larger (a tool progress view can contain both chunk and content).
		n := len(api.JSON(portable.ProjectOutput(e)))
		if n+2 > portable.GateSegmentBytes {
			buffer.block()
		} else if r := c.reserveOutputBytes(e.Session, int64(130+max(n, len(e.Data))+len(e.Session)+len(e.Step)+len(e.Turn)+len(e.Actor)+len(e.Call))); r != nil {
			buffer.events = append(buffer.events, e)
			buffer.charges = append(buffer.charges, r)
		} else {
			buffer.block()
		}
	}
	if !final {
		c.h.outputMu.Unlock()
		return nil, nothing, false
	}
	delete(c.h.outputStreams, key)
	c.h.outputMu.Unlock()
	return buffer.events, buffer.release, buffer.blocked || len(buffer.events) > 0
}

type heldStream struct {
	epoch   int
	blocked bool
	events  []api.Event
	charges []func()
}

func (s *heldStream) release() {
	for _, r := range s.charges {
		r()
	}
	s.charges = nil
}
func (s *heldStream) block() {
	s.release()
	s.events = nil
	s.blocked = true
}

func (c *client) dropOutput(id string) {
	c.h.outputMu.Lock()
	defer c.h.outputMu.Unlock()
	for key, stream := range c.h.outputStreams {
		if key.session == id {
			stream.release()
			delete(c.h.outputStreams, key)
		}
	}
}
