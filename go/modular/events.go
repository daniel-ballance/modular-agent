package modular

import (
	"context"
	"iter"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Events replays committed entries after an optional cursor, then follows the
// actor's live stream. A Lost error carries the last delivered entry cursor.
func (s *Session) Events(ctx context.Context, fromEntry ...string) iter.Seq2[Event, error] {
	return func(yield func(Event, error) bool) {
		if len(fromEntry) > 1 {
			yield(nil, &Error{Code: InvalidParams, Message: "expected one entry cursor"})
			return
		}
		cursor := ""
		if len(fromEntry) > 0 {
			cursor = fromEntry[0]
		}
		pending := make(chan api.BufferedEvent, 256)
		var mu sync.Mutex
		stopped := false
		host := s.agent.a
		reader := host.(interface{ ErasureEpoch(string) (int, error) })
		allowed := func(expected int) bool {
			epoch, err := reader.ErasureEpoch(s.id)
			return err == nil && epoch == expected
		}
		lag := make(chan struct{}, 1)
		subscribe := s.agent.a.(interface {
			SubscribeOutput(func(api.Event) string, func(api.Event)) func()
		})
		stop := subscribe.SubscribeOutput(func(api.Event) string { return s.actorID() }, func(e api.Event) {
			if e.Session != s.id {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if stopped {
				return
			}
			if buffered, ok := api.BufferEvent(host, e); ok {
				select {
				case pending <- buffered:
					return
				default:
					buffered.Release()
				}
			}
			select {
			case lag <- struct{}{}:
			default:
			}
		})
		defer func() {
			stop()
			mu.Lock()
			defer mu.Unlock()
			stopped = true
			close(pending)
			for buffered := range pending {
				buffered.Release()
			}
		}()
		epoch, err := reader.ErasureEpoch(s.id)
		if err != nil {
			yield(nil, appError(err, Unavailable))
			return
		}
		view, err := s.view(ctx)
		if err != nil {
			yield(nil, err)
			return
		}
		seen := make(map[string]bool, len(view.Entries))
		after := cursor == ""
		lastDelivered := ""
		lost := func() { yield(nil, streamLost("session event stream fell behind", lastDelivered)) }
		for _, entry := range view.Entries {
			seen[entry.ID] = true
			if !after {
				after = entry.ID == cursor
				continue
			}
			select {
			case <-lag:
				lost()
				return
			default:
			}
			if ctx.Err() != nil {
				yield(nil, appError(ctx.Err(), CancelledCode))
				return
			}
			if !allowed(epoch) {
				lost()
				return
			}
			raw := api.Event{Kind: "history.added", Time: entry.Time, Session: s.id, Turn: entry.Turn, Step: entry.Step, Call: entry.Call, Actor: entry.Actor, Data: api.JSON(entry)}
			if !yield(sdkEvent(raw), nil) {
				return
			}
			lastDelivered = entry.ID
		}
		if !after {
			yield(nil, &Error{Code: NotFound, Message: "unknown entry cursor"})
			return
		}
		for {
			select {
			case <-lag:
				lost()
				return
			default:
			}
			select {
			case <-ctx.Done():
				yield(nil, appError(ctx.Err(), CancelledCode))
				return
			case <-lag:
				lost()
				return
			case buffered := <-pending:
				raw := buffered.Event
				buffered.Release()
				if !allowed(raw.ErasureEpoch) {
					lost()
					return
				}
				if raw.Kind == "history.added" {
					id := api.Decode[api.Entry](raw.Data).ID
					if seen[id] {
						delete(seen, id)
						continue
					}
				}
				if ev := sdkEvent(raw); ev != nil {
					if !yield(ev, nil) {
						return
					}
					if raw.Kind == "history.added" {
						if id := api.Decode[api.Entry](raw.Data).ID; id != "" {
							lastDelivered = id
						}
					}
				}
			}
		}
	}
}

func streamLost(message, lastDelivered string) *Error {
	var cursor any
	if lastDelivered != "" {
		cursor = lastDelivered
	}
	return &Error{Code: Lost, Message: message, Data: map[string]any{"fromEntry": cursor}}
}
