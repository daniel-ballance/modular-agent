package modular

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// WaitingSummary counts work for the caller without identifying questions or calls.
type WaitingSummary = api.WaitingSummary

type ThreadInfo struct {
	ThreadID  string         `json:"threadId"`
	UpdatedAt time.Time      `json:"updatedAt"`
	Waiting   WaitingSummary `json:"waiting"`
	epoch     int
}

// ListThreadsOptions describes a trusted Interface's authenticated route.
// InTurn reports only questions still offered on this route. A nil callback
// permits late questions, but no in-turn answers. Listing never adds a route.
type ListThreadsOptions struct {
	Actor           Actor
	Tenant, RouteID string
	Scope           func(project, tenant string) bool
	JoinOnOpen      bool
	InTurn          func(sessionID, questionID string) bool
	Offset, Limit   int
}

func (a *Agent) threadMember(s api.Session, host Actor, join bool) bool {
	_, recorded := s.Actors[host.ID]
	if !recorded && host.ID != s.Actor && (!join || !a.severalActors) {
		return false
	}
	return a.a.(agHost).DiscoverForHost(s, host)
}

func (a *Agent) listed(ctx context.Context, s api.Session, opt ListThreadsOptions) bool {
	return s.Project == a.project && s.Tenant == opt.Tenant && api.SessionScopeAllows(ctx, s.Project, s.Tenant) &&
		(opt.Scope == nil || opt.Scope(s.Project, s.Tenant)) && slices.Contains(opt.Actor.Rights, "watch") && api.ConnectionAllows(ctx, "watch") && a.threadMember(s, opt.Actor, opt.JoinOnOpen)
}

func (a *Agent) threadWaiting(ctx context.Context, row api.Session, opt ListThreadsOptions) (WaitingSummary, error) {
	ended := agEndedTurns(row)
	route := api.WaitingRoute{Executor: opt.RouteID, CanAnswer: func(q api.Question) bool {
		if q.Defer && q.Kind != "approval" && ended[q.Turn] {
			return true
		}
		return opt.InTurn != nil && opt.InTurn(row.ID, q.ID)
	}}
	return a.a.WaitingForHost(ctx, row, opt.Actor, route)
}

// ListThreads lists kept threads in this Agent's project and the selected
// tenant, newest change first. The boolean says another page follows. Offset
// counts visible threads only; Limit defaults to 100 and may be at most 500.
func (a *Agent) ListThreads(ctx context.Context, opt ListThreadsOptions) ([]ThreadInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, appError(err, CancelledCode)
	}
	if a.closed.Load() {
		return nil, false, &Error{Code: NotOpen, Message: "agent is closed"}
	}
	if err := validActor(opt.Actor); err != nil {
		return nil, false, err
	}
	if opt.Offset < 0 || opt.Limit < 0 || opt.Limit > 500 {
		return nil, false, &Error{Code: InvalidParams, Message: "invalid thread page"}
	}
	if opt.Limit == 0 {
		opt.Limit = 100
	}
	ordered := []ThreadInfo{}
	if !a.persistent || !slices.Contains(opt.Actor.Rights, "watch") || (opt.Scope != nil && !opt.Scope(a.project, opt.Tenant)) {
		return ordered, false, nil
	}
	rows, err := a.a.List(a.project)
	if err != nil {
		return nil, false, err
	}
	records := map[string]api.Session{}
	for _, row := range rows {
		if !a.listed(ctx, row, opt) {
			continue
		}
		var updated time.Time
		for _, e := range row.Entries {
			if e.Time.After(updated) {
				updated = e.Time
			}
		}
		ordered = append(ordered, ThreadInfo{ThreadID: row.ID, UpdatedAt: updated.UTC()})
		records[row.ID] = row
	}
	slices.SortFunc(ordered, func(a, b ThreadInfo) int {
		if c := b.UpdatedAt.Compare(a.UpdatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ThreadID, b.ThreadID)
	})
	start := min(opt.Offset, len(ordered))
	end := start + min(opt.Limit, len(ordered)-start)
	page := ordered[start:end]
	for i := range page {
		row := records[page[i].ThreadID]
		if page[i].epoch, err = a.a.(agHost).ErasureEpoch(row.ID); err != nil {
			return nil, false, err
		}
		if page[i].Waiting, err = a.threadWaiting(ctx, row, opt); err != nil {
			return nil, false, err
		}
	}
	return page, end < len(ordered), nil
}
