package harness

import (
	"context"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
)

// An open writer is not evidence of a turn. First find the committed start
// that recovery would select, then ask whether this Harness is running it.
func (c *client) turnState(row api.Session) string {
	if row.UnfinishedTurn() == nil {
		return "none"
	}
	if s, err := c.find(row.ID); err == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.running && !s.stopping && s.writerFailure == nil {
			return "running"
		}
	}
	return "interrupted"
}

func (c *client) WaitingForHost(ctx context.Context, row api.Session, host api.Actor, route string) (api.WaitingSummary, error) {
	view := viewForHost(row, host)
	allowed := func(right string) bool {
		return slices.Contains(host.Rights, right) && api.ConnectionAllows(ctx, right) && c.authorized(view, host.ID, right)
	}
	if !api.SessionScopeAllows(ctx, row.Project, row.Tenant) || !allowed("watch") {
		return api.WaitingSummary{}, api.ErrAuthority
	}
	if _, err := c.ErasureEpoch(row.ID); err != nil {
		return api.WaitingSummary{}, err
	}
	w := api.WaitingSummary{Turn: c.turnState(row)}
	if part, err := c.Get("questions"); err == nil {
		for _, q := range part.(api.Questions).Recorded(row) {
			if !q.Answerable || q.Kind == "secret" || len(q.Allowed) != 0 && !slices.Contains(q.Allowed, host.ID) {
				continue
			}
			if q.Kind == "approval" && allowed("approve") || q.Kind != "approval" && allowed("answer") {
				w.Questions++
			}
		}
	}
	if route != "" && allowed("tools") {
		for id, cp := range api.InterfaceHandoffs(row) {
			if interfaceTerminal(row, id).ID != "" {
				continue
			}
			_, saved, ok := c.h.restoreInterface(row, cp)
			if ok && saved.Actor == host.ID && saved.Route == route && slices.Contains(saved.Rights, "tools") && slices.Contains(saved.Rights, "watch") && saved.Deadline > worktime.Now().UnixMilli() {
				w.ToolCalls++
			}
		}
	}
	return w, nil
}
