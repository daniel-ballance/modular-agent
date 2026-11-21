package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

// This fixture returns short pages to exercise cursor forwarding without
// creating hundreds of entries. It uses only the Go SDK's public store port.
type pagedHistoryFixture struct {
	mu                       sync.Mutex
	sessions                 map[string]*pagedFixtureSession
	creates                  []string
	readCursors, listCursors []string
}

type pagedFixtureSession struct {
	meta    modular.HistorySession
	entries []json.RawMessage
	lease   string
}

func (*pagedHistoryFixture) LeaseTTL() time.Duration { return time.Minute }

func (f *pagedHistoryFixture) Create(_ context.Context, id string, meta modular.HistoryMetadata) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	wire, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(wire, &fields); err != nil {
		return err
	}
	if _, ok := fields["id"]; ok || id == "" || meta.Project == "" || meta.Created <= 0 {
		return fmt.Errorf("invalid create: %q %s", id, wire)
	}
	if f.sessions[id] != nil {
		return errors.New("test did not expect a repeated create")
	}
	f.creates = append(f.creates, id)
	f.sessions[id] = &pagedFixtureSession{meta: modular.HistorySession{ID: id, Project: meta.Project, Created: meta.Created, ParentSessionID: meta.ParentSessionID, ForkedFrom: meta.ForkedFrom}}
	return nil
}

func (f *pagedHistoryFixture) Acquire(_ context.Context, id, owner string) (modular.HistoryGrant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[id]
	if s == nil {
		return modular.HistoryGrant{}, &modular.Error{Code: modular.NotFound, Message: "unknown session"}
	}
	if s.lease != "" || owner == "" {
		return modular.HistoryGrant{}, errors.New("invalid acquire")
	}
	s.lease = "fixture-lease"
	return modular.HistoryGrant{Lease: s.lease, TTLMS: float64(f.LeaseTTL().Milliseconds())}, nil
}

func (f *pagedHistoryFixture) Renew(_ context.Context, id, lease string) (float64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s := f.sessions[id]; s == nil || lease == "" || s.lease != lease {
		return 0, modular.ErrHistoryWriterLost
	}
	return float64(f.LeaseTTL().Milliseconds()), nil
}

func (f *pagedHistoryFixture) Release(_ context.Context, id, lease string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s := f.sessions[id]; s != nil && s.lease == lease {
		s.lease = ""
	}
	return nil
}

func (f *pagedHistoryFixture) Append(_ context.Context, id, lease string, entries []json.RawMessage) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[id]
	if s == nil || lease == "" || s.lease != lease {
		return 0, modular.ErrHistoryWriterLost
	}
	s.entries = append(s.entries, entries...)
	return len(entries), nil
}

func fixtureEntryID(raw json.RawMessage) string {
	var e struct{ ID string }
	_ = json.Unmarshal(raw, &e)
	return e.ID
}

func fixturePageAt[T any](rows []T, after string, id func(T) string) (int, error) {
	if after == "" {
		return 0, nil
	}
	for i, row := range rows {
		if id(row) == after {
			return i + 1, nil
		}
	}
	return 0, fmt.Errorf("unknown cursor %q", after)
}

func (f *pagedHistoryFixture) Read(_ context.Context, id, after string, limit int) (modular.HistoryReadPage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if limit != 500 {
		return modular.HistoryReadPage{}, fmt.Errorf("wrong read limit: %d", limit)
	}
	if after != "" {
		f.readCursors = append(f.readCursors, after)
	}
	s := f.sessions[id]
	if s == nil {
		return modular.HistoryReadPage{}, &modular.Error{Code: modular.NotFound, Message: "unknown session"}
	}
	at, err := fixturePageAt(s.entries, after, fixtureEntryID)
	p := modular.HistoryReadPage{Session: s.meta, Entries: []json.RawMessage{}}
	if err != nil || at == len(s.entries) {
		return p, err
	}
	p.Entries = append(p.Entries, s.entries[at])
	if at+1 < len(s.entries) {
		p.Next = fixtureEntryID(s.entries[at])
	}
	return p, nil
}

func (f *pagedHistoryFixture) List(_ context.Context, project, after string, limit int) (modular.HistoryListPage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if limit != 500 {
		return modular.HistoryListPage{}, fmt.Errorf("wrong list limit: %d", limit)
	}
	if after != "" {
		f.listCursors = append(f.listCursors, after)
	}
	var rows []modular.HistorySession
	for _, s := range f.sessions {
		if len(s.entries) != 0 && (project == "" || project == s.meta.Project) {
			rows = append(rows, s.meta)
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Created == rows[j].Created {
			return rows[i].ID < rows[j].ID
		}
		return rows[i].Created > rows[j].Created
	})
	at, err := fixturePageAt(rows, after, func(row modular.HistorySession) string { return row.ID })
	p := modular.HistoryListPage{Sessions: []modular.HistorySession{}}
	if err != nil || at == len(rows) {
		return p, err
	}
	p.Sessions = append(p.Sessions, rows[at])
	if at+1 < len(rows) {
		p.Next = rows[at].ID
	}
	return p, nil
}

func (*pagedHistoryFixture) Erase(context.Context, string, string, []string) ([]string, error) {
	return nil, errors.ErrUnsupported
}

func TestCustomHistoryCreateAndPageCursors(t *testing.T) {
	ctx := t.Context()
	backend := &pagedHistoryFixture{sessions: map[string]*pagedFixtureSession{}}
	store := modular.NewPagedHistoryStore(backend, true, false)
	plugin := modular.Plugin{Name: "paged-history", Replaces: []string{"history"}, Setup: func(r *modular.Registrar) error { return r.HistoryStore(store) }}
	project := t.TempDir()
	a := modulartest.Agent(t, modular.WithProject(project), modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()), modular.WithPlugin(plugin), modulartest.Script(`[{"text":"kept response"}]`))
	var ids []string
	for range 2 {
		s, err := a.Session(ctx)
		if err != nil {
			t.Fatal(err)
		}
		backend.mu.Lock()
		createdEarly := backend.sessions[s.ID()] != nil
		backend.mu.Unlock()
		if createdEarly {
			t.Fatal("create ran before first admitted input")
		}
		if turn, err := s.Prompt(ctx, "commit me"); err != nil || turn.Text != "kept response" {
			t.Fatalf("turn: %+v, %v", turn, err)
		}
		if err := s.WaitIdle(ctx); err != nil {
			t.Fatal(err)
		}
		if err := s.Close(ctx); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, s.ID())
	}
	rows, err := a.Sessions(ctx, project)
	if err != nil || len(rows) != 2 || rows[0].Project != project || rows[1].Project != project {
		t.Fatalf("sessions through paged list: %+v, %v", rows, err)
	}
	opened, err := a.OpenSession(ctx, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if turn, err := opened.LastTurn(ctx); err != nil || turn == nil || turn.Text != "kept response" {
		t.Fatalf("turn through paged read: %+v, %v", turn, err)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.creates) != 2 || backend.creates[0] != ids[0] || backend.creates[1] != ids[1] || len(backend.readCursors) == 0 || len(backend.listCursors) == 0 {
		t.Fatalf("create=%v read cursors=%v list cursors=%v", backend.creates, backend.readCursors, backend.listCursors)
	}
}
