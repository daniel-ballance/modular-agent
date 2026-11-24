package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
	"github.com/daniel-ballance/modular-agent/go/local"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
)

type waitConfig struct {
	Name, Project, Ready, Clock, Reopen string
	TokenFiles                          map[string]string
	MaxApprovalWaitMs                   int64
}

type latch struct {
	reached, release chan struct{}
	once             sync.Once
}

type waitControl struct {
	cfg    waitConfig
	dir    string
	clock  *modulartest.ManualClock
	a      api.API
	store  *history.Store
	fenced atomic.Bool
	mu     sync.Mutex
	holds  map[string]*latch
	gates  map[string]string
}

func (f *waitControl) stopAt(ctx context.Context, name string) {
	f.mu.Lock()
	l := f.holds[name]
	f.mu.Unlock()
	if l == nil {
		return
	}
	l.once.Do(func() { close(l.reached) })
	select {
	case <-l.release:
	case <-ctx.Done():
	}
}

func (f *waitControl) hooks(a api.API) error {
	f.a = a
	if err := a.Handle("session.prepare", "first", func(_ context.Context, v any) (api.Decision, error) {
		p := v.(api.SessionPrepare)
		if !p.Reopened && p.Session.ForkedFrom == "" {
			members := []string{"approver", "other", "answerOnly", "representative", "operator"}
			for _, name := range members {
				if err := a.(interface{ JoinHost(string, api.Actor) error }).JoinHost(p.Session.ID, f.member(name)); err != nil {
					return api.Decision{}, err
				}
			}
		}
		return api.Decision{}, nil
	}); err != nil {
		return err
	}
	if err := a.Handle("turn.prepare", "first", func(ctx context.Context, _ any) (api.Decision, error) {
		f.stopAt(ctx, "answerCommit")
		return api.Decision{}, nil
	}); err != nil {
		return err
	}
	if err := a.Handle("runtime.tool.before", "first", func(ctx context.Context, _ any) (api.Decision, error) {
		f.stopAt(ctx, "continuationStart")
		f.stopAt(ctx, "beforeHandoff")
		return api.Decision{}, nil
	}); err != nil {
		return err
	}
	if err := a.Handle("runtime.tool.after", "first", func(ctx context.Context, _ any) (api.Decision, error) {
		if f.cfg.Name == "reopen-afterEffect" {
			f.stopAt(ctx, "afterEffect")
		}
		return api.Decision{}, nil
	}); err != nil {
		return err
	}
	if err := a.Handle("output", "first", func(ctx context.Context, v any) (api.Decision, error) {
		out := v.(api.Output)
		if out.Event.Kind == "history.added" && api.Decode[api.Entry](out.Event.Data).Kind == "tool.open" {
			f.stopAt(ctx, "requestPending")
		}
		return api.Decision{}, nil
	}); err != nil {
		return err
	}
	return a.Handle("output.batch", "last", func(_ context.Context, v any) (api.Decision, error) {
		b := v.(api.OutputBatch)
		f.mu.Lock()
		mode := f.gates[b.Recipient]
		f.mu.Unlock()
		for i, e := range b.Events {
			if e.Method != "_modular-agent/requests" {
				continue
			}
			switch mode {
			case "block":
				return api.Decision{Refuse: true}, nil
			case "redact":
				var m map[string][]map[string]any
				if err := json.Unmarshal(e.Data, &m); err != nil {
					return api.Decision{}, err
				}
				for _, q := range m["requests"] {
					if call, ok := q["call"].(map[string]any); ok {
						if in, ok := call["input"].(map[string]any); ok {
							in["command"] = "Withheld"
						}
					}
					q["question"] = "Withheld"
				}
				b.Events[i].Data = api.JSON(m)
			}
		}
		return api.Decision{Value: b}, nil
	})
}

func (f *waitControl) member(role string) api.Actor {
	rights := []string{"watch", "answer", "approve"}
	switch role {
	case "operator":
		rights = []string{"watch", "grant", "answer"}
		if f.cfg.Name == "worker-ceiling" {
			rights = slices.Clone(api.Rights)
		}
	case "worker":
		rights = slices.DeleteFunc(slices.Clone(api.Rights), func(v string) bool { return v == "answer" || v == "approve" })
	case "answerOnly", "representative":
		rights = []string{"watch", "answer"}
	}
	return api.Actor{ID: role, Kind: "host", Rights: rights}
}

type waitBackend struct {
	*history.Store
	f *waitControl
}
type waitWriter struct {
	api.Lease
	f *waitControl
	n int
}

func (s *waitBackend) Acquire(id string) (api.Lease, error) {
	l, err := s.Store.Acquire(id)
	if err != nil {
		return nil, err
	}
	return &waitWriter{Lease: l, f: s.f}, nil
}
func (l *waitWriter) CheckWriter() error {
	if l.f.fenced.Load() {
		return api.ErrWriterLost
	}
	return nil
}
func (l *waitWriter) Load() (api.Session, error) {
	s, err := l.Lease.Load()
	if err == nil {
		l.n = len(s.Entries)
	}
	return s, err
}
func (l *waitWriter) Save(s api.Session) error {
	if err := l.CheckWriter(); err != nil {
		return err
	}
	if err := l.Lease.Save(s); err != nil {
		return err
	}
	if len(s.Entries) <= l.n {
		return nil
	}
	batch := []string{}
	for _, e := range s.Entries[l.n:] {
		batch = append(batch, e.ID)
	}
	l.n = len(s.Entries)
	w, err := os.OpenFile(filepath.Join(l.f.dir, s.ID+".batches"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	return errors.Join(json.NewEncoder(w).Encode(batch), w.Close())
}
func (l *waitWriter) SaveErasure(s api.Session) error {
	return l.Lease.(api.ExactErasureLease).SaveErasure(s)
}

func readClock(file string) (time.Time, error) {
	b, e := os.ReadFile(file)
	if e != nil {
		return time.Time{}, e
	}
	var ms int64
	e = json.Unmarshal(b, &ms)
	return time.UnixMilli(ms), e
}

type controlRequest struct{ Operation, SessionID, At, Role, Mode, Kind, Right string }

func (f *waitControl) act(ctx context.Context, q controlRequest) (any, error) {
	empty := struct{}{}
	switch q.Operation {
	case "pause":
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.holds[q.At] != nil {
			return nil, errors.New("already paused")
		}
		f.holds[q.At] = &latch{reached: make(chan struct{}), release: make(chan struct{})}
	case "release":
		f.mu.Lock()
		defer f.mu.Unlock()
		for name, l := range f.holds {
			if q.At == "" || q.At == name {
				close(l.release)
				delete(f.holds, name)
			}
		}
	case "reached":
		f.mu.Lock()
		l := f.holds[q.At]
		f.mu.Unlock()
		if l == nil {
			return nil, errors.New("unknown latch")
		}
		select {
		case <-l.reached:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	case "inspect":
		if filepath.Base(q.SessionID) != q.SessionID || q.SessionID == "" {
			return nil, errors.New("invalid session id")
		}
		b, err := os.ReadFile(filepath.Join(f.dir, q.SessionID+".batches"))
		if err != nil {
			return nil, err
		}
		rows, err := f.store.List(f.cfg.Project)
		if err != nil {
			return nil, err
		}
		entries := map[string]map[string]any{}
		for _, s := range rows {
			if s.ID == q.SessionID {
				for _, e := range s.Entries {
					entries[e.ID] = portable.Entry(e)
				}
			}
		}
		var batches [][]map[string]any
		dec := json.NewDecoder(bytes.NewReader(b))
		for {
			var ids []string
			err := dec.Decode(&ids)
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			batch := make([]map[string]any, 0, len(ids))
			for _, id := range ids {
				if entries[id] == nil {
					return nil, errors.New("batch entry missing from store")
				}
				batch = append(batch, entries[id])
			}
			batches = append(batches, batch)
		}
		return map[string]any{"batches": batches}, nil
	case "tick":
		now, err := readClock(f.cfg.Clock)
		if err != nil {
			return nil, err
		}
		f.clock.Advance(now.Sub(f.clock.Now()))
	case "idle":
		_, err := f.a.Wait(ctx, q.SessionID)
		if f.fenced.Load() && errors.Is(err, api.ErrWriterLost) {
			err = nil
		}
		return empty, err
	case "gate":
		f.mu.Lock()
		f.gates[q.Role] = q.Mode
		f.mu.Unlock()
	case "cut", "revoke":
		switch q.Kind {
		case "stale-writer":
			f.fenced.Store(true)
			return empty, nil
		case "route-authorization":
			f.mu.Lock()
			f.gates["approver"] = "block"
			f.mu.Unlock()
			return empty, nil
		case "worker-ceiling":
			rights := slices.DeleteFunc(slices.Clone(api.Rights), func(s string) bool { return s == "tools" })
			return empty, f.a.(interface {
				Limit(context.Context, string, []string) error
			}).Limit(api.AsActor(ctx, "operator"), q.SessionID, rights)
		case "approver-rights":
			q.Role, q.Right = "approver", "approve"
		}
		a := f.member(q.Role)
		a.Rights = slices.DeleteFunc(a.Rights, func(v string) bool { return v == q.Right })
		// A member with grant can narrow a peer to a subset of its present rights.
		return empty, f.a.Grant(api.AsActor(ctx, "operator"), q.SessionID, a)
	default:
		return nil, errors.New("unknown fixture operation")
	}
	return empty, nil
}

// Remove only the allow's private proof in this deliberately corrupt fixture.
func dropApprovalProof(dir string) error {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) != 1 {
		return errors.New("missing isolated waiting snapshot")
	}
	path := files[0]
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var snapshot map[string]json.RawMessage
	if err = json.Unmarshal(b, &snapshot); err != nil {
		return err
	}
	var rows []map[string]json.RawMessage
	if err = json.Unmarshal(snapshot["entries"], &rows); err != nil {
		return err
	}
	for _, e := range rows {
		if api.Decode[string](e["kind"]) != "inputAnswer" {
			continue
		}
		var d map[string]json.RawMessage
		if err = json.Unmarshal(e["data"], &d); err != nil {
			return err
		}
		if _, ok := d["approvalView"]; !ok {
			continue
		}
		delete(d, "approvalView")
		e["data"] = api.JSON(d)
		snapshot["entries"] = api.JSON(rows)
		if err = os.WriteFile(path+".new", api.JSON(snapshot), 0600); err != nil {
			return err
		}
		return os.Rename(path+".new", path)
	}
	return errors.New("no allow proof to remove")
}

func serveWaiting() error {
	dir := os.Getenv("MODULAR_AGENT_DATA_DIR")
	conf := os.Getenv("MA_ACP_WAIT_FIXTURE")
	if os.Getenv("MODULAR_AGENT_CONFORMANCE") != "1" || !filepath.IsAbs(dir) || conf != filepath.Join(dir, "fixture.json") {
		return errors.New("acp-waiting requires a disposable conformance directory")
	}
	var cfg waitConfig
	b, err := os.ReadFile(conf)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(b, &cfg); err != nil {
		return err
	}
	if cfg.Ready != filepath.Join(dir, "ready.json") || cfg.Clock != filepath.Join(dir, "clock.json") {
		return errors.New("invalid fixture locations")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	start, err := readClock(cfg.Clock)
	if err != nil {
		return err
	}
	clock, restore := modulartest.InstallClock(start)
	defer restore()
	f := &waitControl{cfg: cfg, dir: dir, clock: clock, holds: map[string]*latch{}, gates: map[string]string{}}
	if cfg.Reopen == "missing-proof" {
		if err := dropApprovalProof(filepath.Join(dir, "sessions")); err != nil {
			return err
		}
	}
	st, err := history.New(filepath.Join(dir, "sessions"))
	if err != nil {
		return err
	}
	f.store = st
	limits := harness.DefaultCapacityLimits()
	if cfg.Name == "capacity" {
		limits.Session.Calls = 1
	}
	h, err := vanilla.New(vanilla.Options{Project: cfg.Project, DataDir: dir, History: dir, Model: conformancemodel.ID, Provider: conformancemodel.Plugin(), Runtime: durable.Plugin(), Environment: local.GitPluginAt(filepath.Join(dir, "commands"), dir), Capacity: harness.NewCapacity(limits), Store: api.Plugin{Name: "history", Setup: func(a api.API) error { return a.Provide("history", &waitBackend{st, f}) }}})
	if err != nil {
		return err
	}
	defer h.Close()
	h.ConfigureCoveredApprovals(true)
	if cfg.Reopen != "unsupported" {
		h.ConfigureWaitingApprovals(cfg.MaxApprovalWaitMs)
	}
	if err = h.Load(api.Plugin{Name: "approval-fixture", Setup: f.hooks}); err != nil {
		return err
	}
	iface, err := h.API().Get("interface.acp")
	if err != nil {
		return err
	}
	i := iface.(*acpinterface.Interface)
	policy := func(role string) acpinterface.Principal {
		p := acpinterface.Principal{Actor: f.member(role), Projects: []string{cfg.Project}, Represents: []string{}}
		if role == "tenant" {
			p.Tenants = []string{"different"}
		}
		if role == "representative" {
			p.Represents = []string{"approver"}
		}
		return p
	}
	tokens := map[string]acpinterface.Principal{}
	token := func(role string) (string, error) {
		path := cfg.TokenFiles[role]
		if path != filepath.Join(dir, role+".token") {
			return "", errors.New("invalid fixture token path")
		}
		return wswire.ReadToken(path)
	}
	for _, role := range []string{"approver", "other", "tenant", "answerOnly", "representative"} {
		t, e := token(role)
		if e != nil {
			return e
		}
		p := policy(role)
		tokens[t] = p
		acpinterface.InstallApprovalRoute(h.API(), cfg.Project, p)
	}
	ws, err := wswire.Listen(ctx, "127.0.0.1:0", nil, wswire.ACP, tokens, func(ctx context.Context, c *wswire.Conn, p acpinterface.Principal) {
		c.EnableACPControl(0)
		_ = i.ServePrincipal(ctx, c, c, nil, acpinterface.Projects{}, p)
	})
	if err != nil {
		return err
	}
	defer ws.Close()
	key, err := token("control")
	if err != nil {
		return err
	}
	ls, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	control := http.Server{ReadHeaderTimeout: 3 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+key)) != 1 {
			w.WriteHeader(403)
			return
		}
		var q controlRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&q); err != nil {
			w.WriteHeader(400)
			return
		}
		v, err := f.act(r.Context(), q)
		if err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		_ = json.NewEncoder(w).Encode(v)
	})}
	go control.Serve(ls)
	defer control.Close()
	if err = os.WriteFile(cfg.Ready, api.JSON(map[string]string{"acp": ws.URL, "control": "http://" + ls.Addr().String()}), 0600); err != nil {
		return err
	}
	return i.ServeStdio(ctx, os.Stdin, os.Stdout, nil, acpinterface.Projects{}, policy("worker"))
}
