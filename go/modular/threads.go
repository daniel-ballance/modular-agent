package modular

import (
	"context"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// SessionViewer describes the authenticated actor, scope and executor route.
// InTurn identifies question views still held on that route.
type SessionViewer = api.SessionViewer
type SessionSummary = api.SessionSummary
type WaitingSummary = api.WaitingSummary

// SessionSummary reads one kept session without opening it. It returns nil
// when the record is missing or outside the viewer's effective watch grant.
func (a *Agent) SessionSummary(ctx context.Context, id string, viewer SessionViewer) (*SessionSummary, error) {
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if a.closed.Load() {
		return nil, &Error{Code: NotOpen, Message: "agent is closed"}
	}
	if err := validActor(viewer.Actor); err != nil {
		return nil, err
	}
	if !a.persistent {
		return nil, nil
	}
	rows, err := a.a.List(a.project)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.ID == id {
			return a.summary(ctx, row, viewer)
		}
	}
	return nil, nil
}

// The paged listing already has the committed row. Do not list the store again for each ID.
func (a *Agent) summary(ctx context.Context, row api.Session, viewer SessionViewer) (*SessionSummary, error) {
	if row.Project != a.project || !a.persistent {
		return nil, nil
	}
	viewer.JoinOnOpen = viewer.JoinOnOpen && a.severalActors
	return a.a.SessionSummary(ctx, row, viewer)
}
