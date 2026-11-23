package harness

import (
	"context"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
)

// An open writer is not evidence of a turn. First find the committed start
// that recovery would select, then ask whether this Harness is running it.
func (c *client) turnState(row api.Session) (string, error) {
	if row.UnfinishedTurn() == nil {
		return "none", nil
	}
	if s, err := c.find(row.ID); err == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.running && !s.stopping && s.writerFailure == nil {
			return "running", nil
		}
	} else if store, err := c.Get("history"); err == nil {
		if probe, ok := store.(interface{ WriterHeld(string) (bool, error) }); ok {
			held, err := probe.WriterHeld(row.ID)
			if err != nil {
				return "", err
			}
			if held {
				return "running", nil
			}
		}
	}
	return "interrupted", nil
}

func (c *client) SessionSummary(ctx context.Context, row api.Session, viewer api.SessionViewer) (*api.SessionSummary, error) {
	host := viewer.Actor
	_, recorded := row.Actors[host.ID]
	if len(row.Entries) == 0 || row.Tenant != viewer.Tenant || viewer.Scope != nil && !viewer.Scope(row.Project, row.Tenant) ||
		!viewer.JoinOnOpen && !recorded && row.Actor != host.ID {
		return nil, nil
	}
	view := viewForHost(row, host)
	allowed := func(right string) bool {
		return slices.Contains(host.Rights, right) && api.ConnectionAllows(ctx, right) && c.authorized(view, host.ID, right)
	}
	if !api.SessionScopeAllows(ctx, row.Project, row.Tenant) || !allowed("watch") {
		return nil, nil
	}
	if _, err := c.ErasureEpoch(row.ID); err != nil {
		return nil, err
	}
	turn, err := c.turnState(row)
	if err != nil {
		return nil, err
	}
	w := api.WaitingSummary{Turn: turn}
	if part, err := c.Get("questions"); err == nil {
		ended := map[string]bool{}
		for _, e := range row.Branch() {
			if e.WasKind("turn.end") {
				ended[e.Turn] = true
			}
		}
		for _, q := range part.(api.Questions).Recorded(row) {
			if !q.Answerable || q.Kind == "secret" || len(q.Allowed) != 0 && !slices.Contains(q.Allowed, host.ID) {
				continue
			}
			late := q.Defer && q.Kind != "approval" && ended[q.Turn]
			if !late && (viewer.InTurn == nil || !viewer.InTurn(row.ID, q.ID)) {
				continue
			}
			if q.Kind == "approval" && allowed("approve") || q.Kind != "approval" && allowed("answer") {
				w.Questions++
			}
		}
	}
	if viewer.RouteID != "" && allowed("tools") {
		for id, cp := range api.InterfaceHandoffs(row) {
			if interfaceTerminal(row, id).ID != "" {
				continue
			}
			_, saved, ok := c.h.restoreInterface(row, cp)
			if ok && saved.Actor == host.ID && saved.Route == viewer.RouteID && slices.Contains(saved.Rights, "tools") && slices.Contains(saved.Rights, "watch") && saved.Deadline > worktime.Now().UnixMilli() {
				w.ToolCalls++
			}
		}
	}
	return &api.SessionSummary{ID: row.ID, Project: row.Project, UpdatedAt: row.Entries[len(row.Entries)-1].Time.UTC(), Waiting: w}, nil
}
