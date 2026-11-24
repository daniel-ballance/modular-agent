package harness

import (
	"context"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

// CommittedSnapshot pairs the watermark with the next commit signal under the
// writer lock. A reader keeps a position in history, not a queue of event bodies.
func (c *client) CommittedSnapshot(id string) (api.Session, <-chan struct{}, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Session{}, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.admitErasureView(s.data); err != nil {
		return api.Session{}, nil, err
	}
	if s.committed == nil {
		s.committed = make(chan struct{})
	}
	return copySession(s.data), s.committed, nil
}

// ReadForHost never opens a session, recovers work, joins an actor or marks
// presence. Closed sessions have no local commit signal.
func (c *client) ReadForHost(ctx context.Context, project, id string) (api.Session, <-chan struct{}, error) {
	var row api.Session
	var next <-chan struct{}
	var err error
	if _, open := c.find(id); open == nil {
		row, next, err = c.CommittedSnapshot(id)
	} else {
		var rows []api.Session
		rows, err = c.List(project)
		for _, v := range rows {
			if v.ID == id {
				row = v
				break
			}
		}
	}
	if err != nil {
		return row, nil, err
	}
	if row.ID == "" || row.Project != project || !c.authorizedBy(row, ctx, "watch") {
		return api.Session{}, nil, api.ErrAuthority
	}
	return row, next, nil
}

// HostHistoryView applies the native policy to the same snapshot the reader
// is projecting. The Interface then gates each source as a shared entry.
func (c *client) HostHistoryView(ctx context.Context, snap api.Session) (api.Session, error) {
	snap.Entries = slices.Clone(snap.Entries)
	for i, e := range snap.Entries {
		snap.Entries[i] = portable.PublicEntry(e)
	}
	out, err := c.output(ctx, api.Event{Kind: "history.view", Session: snap.ID, Data: api.JSON(snap)})
	if err != nil || out.Hold {
		return api.Session{}, api.ErrOutputWithheld
	}
	return api.Decode[api.Session](out.Event.Data), nil
}
