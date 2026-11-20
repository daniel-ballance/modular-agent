package modular

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

type HistoryPage struct {
	Entries []HistoryEntry `json:"entries"`
	Next    string         `json:"next,omitempty"`
}

// History reads the current call's raw session record, starting after cursor.
// It is not an actor's gated history view.
func (t *ToolContext) History(ctx context.Context, cursor ...string) (HistoryPage, error) {
	if len(cursor) > 1 {
		return HistoryPage{}, &Error{Code: InvalidRequest, Message: "expected one history cursor"}
	}
	var page HistoryPage
	err := t.callback(ctx, func(ctx context.Context) error {
		params := pluginrpc.Object{"sessionId": t.SessionID}
		if len(cursor) != 0 && cursor[0] != "" {
			params["after"] = cursor[0]
		}
		if t.server != nil {
			return t.server.Callback(ctx, "host/history", params, &page)
		}
		snap, err := t.host.Snapshot(t.SessionID)
		if err != nil {
			return err
		}
		value, err := pluginrpc.HistoryPage(snap, params)
		if err != nil {
			return err
		}
		return decodeInto(value, &page)
	})
	return page, appError(err, InvalidRequest)
}

// Emit sends a non-recorded custom event attributed to the tool's plugin.
func (t *ToolContext) Emit(ctx context.Context, kind string, data any) error {
	if !strings.Contains(kind, ".") || strings.HasPrefix(kind, ".") || strings.HasSuffix(kind, ".") {
		return &Error{Code: InvalidRequest, Message: "custom event type must be dotted"}
	}
	return appError(t.callback(ctx, func(ctx context.Context) error {
		raw, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if t.server != nil {
			return t.server.Notify(ctx, "host/emit", pluginrpc.Object{"sessionId": t.SessionID, "type": kind, "data": json.RawMessage(raw)})
		}
		t.host.Emit(ctx, api.Event{Kind: "plugin." + t.plugin + "." + kind, Session: t.SessionID, Actor: t.ActorID, Call: t.CallID, Data: raw})
		return nil
	}), InvalidRequest)
}

// Credential reads a named non-Provider credential. Such a tool must be
// registered InProcessOnly before it can be used in a composition.
func (t *ToolContext) Credential(ctx context.Context, name string) (string, error) {
	var result string
	err := t.callback(ctx, func(ctx context.Context) error {
		if t.server != nil {
			return &Error{Code: NotSupported, Message: "named credentials are in-process only"}
		}
		if !t.only {
			return &Error{Code: NotSupported, Message: "tool must declare InProcessOnly to read a named credential"}
		}
		if name == "" {
			return &Error{Code: InvalidRequest, Message: "credential name is required"}
		}
		if _, err := t.host.Get("provider." + name); err == nil {
			return &Error{Code: InvalidRequest, Message: "tool cannot read Provider credentials"}
		}
		store, err := t.host.Get("credentials")
		if err != nil {
			return &Error{Code: NotFound, Message: "credential unavailable"}
		}
		result, err = store.(CredentialStore).Get(ctx, name)
		if err != nil || result == "" {
			return &Error{Code: NotFound, Message: "credential unavailable"}
		}
		return nil
	})
	return result, err
}

func (t *ToolContext) callback(ctx context.Context, fn func(context.Context) error) error {
	if t.settled.Load() {
		return &Error{Code: InvalidRequest, Message: "call has settled"}
	}
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	if err := t.ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	work, cancel := context.WithCancel(t.ctx)
	stop := context.AfterFunc(ctx, cancel)
	defer func() { stop(); cancel() }()
	return fn(work)
}
