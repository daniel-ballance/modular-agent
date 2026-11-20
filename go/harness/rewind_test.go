package harness_test

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/local"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type pointTrace struct {
	*local.Environment
	checks, restores []string
	saves            int
	beforeRestore    func(string) error
}

func (e *pointTrace) SavePoint(ctx context.Context, cwd string) (string, error) {
	e.saves++
	return e.Environment.SavePoint(ctx, cwd)
}

func (e *pointTrace) CheckPoint(ctx context.Context, cwd, point string) error {
	e.checks = append(e.checks, point)
	return e.Environment.CheckPoint(ctx, cwd, point)
}

func (e *pointTrace) RestorePoint(ctx context.Context, cwd, point string) error {
	e.restores = append(e.restores, point)
	if e.beforeRestore != nil {
		if err := e.beforeRestore(point); err != nil {
			return err
		}
	}
	return e.Environment.RestorePoint(ctx, cwd, point)
}

var errLostAppend = errors.New("fixture lost the append acknowledgement and writer")

type rewindStore struct {
	api.Store
	loseAt int // one-based position append for this fault
}

type rewindLease struct {
	api.Lease
	store *rewindStore
	lost  bool
}

func (s *rewindStore) Acquire(id string) (api.Lease, error) {
	l, err := s.Store.Acquire(id)
	if err != nil {
		return nil, err
	}
	return &rewindLease{Lease: l, store: s}, nil
}

func (l *rewindLease) CheckWriter() error {
	if l.lost {
		return errLostAppend
	}
	return nil
}

func (l *rewindLease) Save(s api.Session) error {
	if err := l.Lease.Save(s); err != nil {
		return err
	}
	if s.Entries[len(s.Entries)-1].Kind == "position" && l.store.loseAt > 0 {
		l.store.loseAt--
		if l.store.loseAt == 0 {
			l.lost = true
			return errLostAppend
		}
	}
	return nil
}

type rewindFixture struct {
	t                        *testing.T
	ctx                      context.Context
	project, file            string
	id, target, head, first  string
	later                    string
	pointState, historyState string
	env                      *pointTrace
	store                    *rewindStore
	h                        *harness.Harness
	a                        api.API
}

func newRewindFixture(t *testing.T) *rewindFixture {
	f := &rewindFixture{t: t, ctx: context.Background(), project: t.TempDir(), pointState: t.TempDir(), historyState: t.TempDir()}
	f.file = filepath.Join(f.project, "working.txt")
	f.startHost()
	var err error
	f.id, err = f.a.New(f.ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	f.target = f.record(api.Entry{Kind: "test.mark"})
	f.write("before")
	f.first = f.turnPoint("first")
	f.write("between")
	f.later = f.turnPoint("later")
	f.write("after")
	return f
}

func (f *rewindFixture) startHost() {
	f.t.Helper()
	st, err := history.New(f.historyState)
	if err != nil {
		f.t.Fatal(err)
	}
	env := &pointTrace{Environment: local.NewAt(f.pointState)}
	store := &rewindStore{Store: st}
	h := harness.New()
	f.t.Cleanup(func() { _ = h.Close() })
	if err := h.Load(api.Plugin{Name: "fixture", Close: env.Close, Setup: func(a api.API) error {
		if err := a.Provide("history", store); err != nil {
			return err
		}
		return a.Provide("working-environment", env)
	}}); err != nil {
		f.t.Fatal(err)
	}
	f.h, f.a, f.env, f.store = h, h.API(), env, store
}

func (f *rewindFixture) restart() {
	f.t.Helper()
	if err := f.h.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.startHost()
}

func (f *rewindFixture) write(value string) {
	f.t.Helper()
	if err := os.WriteFile(f.file, []byte(value), 0600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *rewindFixture) assertFile(value string) {
	f.t.Helper()
	data, err := os.ReadFile(f.file)
	if err != nil || string(data) != value {
		f.t.Fatalf("file = %q, %v; want %q", data, err, value)
	}
}

func (f *rewindFixture) record(e api.Entry) string {
	f.t.Helper()
	e, err := f.a.Record(f.ctx, f.id, e)
	if err != nil {
		f.t.Fatal(err)
	}
	return e.ID
}

func (f *rewindFixture) turnPoint(turn string) string {
	f.t.Helper()
	ctx := api.WithExecution(f.ctx, api.Execution{Session: f.id})
	point, err := f.env.Environment.SavePoint(ctx, f.project)
	if err != nil {
		f.t.Fatal(err)
	}
	f.record(api.Entry{Kind: "turn.start", Turn: turn, Point: point, Data: api.JSON(api.TurnStart{})})
	f.head = f.record(api.Entry{Kind: "turn.end", Turn: turn, Data: api.JSON(api.Outcome{Status: "completed"})})
	return point
}

func (f *rewindFixture) positions() []api.Entry {
	f.t.Helper()
	sessions, err := f.store.List(f.project)
	if err != nil {
		f.t.Fatal(err)
	}
	var positions []api.Entry
	for _, s := range sessions {
		if s.ID == f.id {
			for _, e := range s.Entries {
				if e.Kind == "position" {
					positions = append(positions, e)
				}
			}
		}
	}
	return positions
}

func (f *rewindFixture) assertHead(want string) {
	f.t.Helper()
	s, err := f.a.Snapshot(f.id)
	if err != nil || s.Position != want {
		f.t.Fatalf("head = %q, %v; want %s", s.Position, err, want)
	}
}

func TestRewindChecksLaterPointsBeforeSaveAndUsesCanonicalProject(t *testing.T) {
	f := newRewindFixture(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(f.project, alias); err != nil {
		t.Fatal(err)
	}
	other, err := f.a.New(f.ctx, alias)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.a.Move(f.ctx, f.id, f.target, true); err == nil || len(f.env.checks) != 0 {
		t.Fatalf("rewind with another hosted session: %v, checks %v", err, f.env.checks)
	}
	if err := f.a.CloseSession(other); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(f.pointState, "points", f.later)); err != nil {
		t.Fatal(err)
	}
	if err := f.a.Move(f.ctx, f.id, f.target, true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing later point: %v", err)
	}
	if !reflect.DeepEqual(f.env.checks, []string{f.first, f.later}) || f.env.saves != 0 || len(f.env.restores) != 0 || len(f.positions()) != 0 {
		t.Fatalf("preflight had effects: checks %v, saves %d, restores %v", f.env.checks, f.env.saves, f.env.restores)
	}
	f.assertHead(f.head)
	f.assertFile("after")
}

func TestRewindRecoveryAfterLostAppend(t *testing.T) {
	for _, tt := range []struct {
		name            string
		loseAt          int
		before, after   string
		beforeN, afterN int
	}{
		{"intent", 1, "after", "before", 0, 1},
		{"completion", 2, "before", "edited", 1, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newRewindFixture(t)
			f.store.loseAt = tt.loseAt
			if err := f.a.Move(f.ctx, f.id, f.target, true); !errors.Is(err, errLostAppend) {
				t.Fatalf("rewind error = %v", err)
			}
			if len(f.env.restores) != tt.beforeN || len(f.positions()) != tt.loseAt {
				t.Fatalf("restores %v, positions %v", f.env.restores, f.positions())
			}
			f.assertFile(tt.before)
			f.restart()
			if tt.loseAt == 1 {
				if _, err := f.a.New(f.ctx, f.project); err == nil {
					t.Fatal("new host let another session use the project before recovery")
				}
			} else {
				f.write("edited")
			}
			if err := f.a.Open(f.ctx, f.id); err != nil {
				t.Fatal(err)
			}
			if len(f.env.restores) != tt.afterN || len(f.positions()) != 2 {
				t.Fatalf("restores %v, positions %v", f.env.restores, f.positions())
			}
			f.assertHead(f.target)
			f.assertFile(tt.after)
		})
	}
}

func TestRewindRecoveryOnlyRetriesCompensatingIntent(t *testing.T) {
	f := newRewindFixture(t)
	f.env.beforeRestore = func(point string) error {
		positions := f.positions()
		last := positions[len(positions)-1]
		p, err := api.ReadPosition(last.Data)
		if err != nil || p.Restore == nil || p.Restore.Point != point {
			t.Fatalf("restore %q attempted without a committed intent: %v, %v", point, p, err)
		}
		if point == f.first {
			f.write("partially restored")
			return fs.ErrNotExist // point disappeared after preflight
		}
		return errors.New("undo currently unavailable")
	}
	if err := f.a.Move(f.ctx, f.id, f.target, true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("move error = %v", err)
	}
	positions := f.positions()
	if len(positions) != 2 {
		t.Fatalf("want two unresolved intents: %v", positions)
	}
	p, _ := api.ReadPosition(positions[0].Data)
	undo, _ := api.ReadPosition(positions[1].Data)
	if positions[0].Parent != f.head || positions[1].Parent != f.target || undo.Target() != f.head || *undo.Restore != (api.RestoreIntent{Point: p.Restore.Undo, Undo: p.Restore.Point}) {
		t.Fatalf("invalid compensation: %v", positions)
	}
	if _, err := f.a.Record(f.ctx, f.id, api.Entry{Kind: "test.blocked"}); err == nil {
		t.Fatal("unresolved rewind allowed an interleaving record")
	}
	f.restart()
	f.env.beforeRestore = func(string) error { return fs.ErrNotExist }
	if err := f.a.Open(f.ctx, f.id); !errors.Is(err, fs.ErrNotExist) || len(f.positions()) != 2 {
		t.Fatalf("reopen completed missing undo: %v", err)
	}
	f.assertFile("partially restored")
	f.env.restores = nil
	f.env.beforeRestore = nil
	if err := f.a.Open(f.ctx, f.id); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.env.restores, []string{undo.Restore.Point}) || len(f.positions()) != 3 {
		t.Fatalf("reopen retried more than the undo: %v", f.env.restores)
	}
	f.assertHead(f.head)
	f.assertFile("after")
}
