package modular

import (
	"context"
	"iter"

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
		pending := make(chan api.Event, 256)
		lag := make(chan struct{}, 1)
		subscribe := s.agent.a.(interface {
			SubscribeOutput(func(api.Event) string, func(api.Event)) func()
		})
		stop := subscribe.SubscribeOutput(func(api.Event) string { return localActor }, func(e api.Event) {
			if e.Session != s.id {
				return
			}
			select {
			case pending <- e:
			default:
				select {
				case lag <- struct{}{}:
				default:
				}
			}
		})
		defer stop()
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
			case raw := <-pending:
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
