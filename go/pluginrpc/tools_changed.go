package pluginrpc

import (
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
	"sync"
)

type changedToolsKey struct{}

type toolChanges struct {
	mu  sync.Mutex
	ids []string
}

// The peer captures the live parent at notification receipt. Its inbox runs
// notifications before delivering the answer, so changes belong to that call
// even if other concurrent calls finish first.
func (r *remote) callTrackingTools(ctx context.Context, method string, params any, out any, acceptCancelled bool) error {
	changes := &toolChanges{}
	ctx = context.WithValue(ctx, changedToolsKey{}, changes)
	callErr := r.peer.call(ctx, method, params, out, acceptCancelled)
	changes.mu.Lock()
	changed := slices.Clone(changes.ids)
	changes.mu.Unlock()
	w, _ := ctx.Value(workKey{}).(work)
	for _, id := range changed {
		if err := r.refreshChanged(ctx, id, w.session); err != nil {
			r.host.a.Emit(ctx, api.Event{Kind: "plugin.problem", Session: w.session, Data: mustJSON(err.Error())})
		}
	}
	if callErr != nil {
		return fmt.Errorf("plugin %s: %w", r.reg.Name, callErr)
	}
	return nil
}

func (r *remote) refreshChanged(ctx context.Context, id, session string) error {
	source := r.sources[id]
	if source == nil {
		return fault("invalid_request", "changed unknown tool source")
	}
	if source.reg.PerSession && session == "" {
		// No request scoped this change. Invalidate each list; it will be
		// refreshed for its session before that list is next offered.
		source.mu.Lock()
		clear(source.lists)
		source.mu.Unlock()
		return nil
	}
	return source.refresh(ctx, session, false)
}

func (r *remote) toolsChanged(ctx context.Context, v object) {
	id := str(v, "toolSource")
	if has(v, "parentRequestId") {
		ctx, ok := r.peer.requestParent(ctx, mustJSON(v["parentRequestId"]))
		if !ok {
			return
		}
		if changes, _ := ctx.Value(changedToolsKey{}).(*toolChanges); changes != nil {
			changes.mu.Lock()
			if !slices.Contains(changes.ids, id) {
				changes.ids = append(changes.ids, id)
			}
			changes.mu.Unlock()
		}
		return
	}
	// A parentless change isn't tied to any response, and the inbox must
	// remain free to receive the answer to this tools/list request.
	go func() {
		if err := r.refreshChanged(ctx, id, ""); err != nil {
			r.host.a.Emit(ctx, api.Event{Kind: "plugin.problem", Data: mustJSON(err.Error())})
		}
	}()
}
