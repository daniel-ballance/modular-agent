package scenarios

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

// The controlling interpreter stays outside the agent and its plugin process
// group. A kill cannot destroy its clock, request ID, observations or counter.
type waitSetup struct {
	Path, Dir string
	Placement placement
	Services  []modular.ServicePlugin
}

func (r run) checkWaiting(t *testing.T, path string, sc scenario) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var groups fixtureGroups
	svc, err := groups.start(ctx, r, sc)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := groups.stop(); err != nil {
			t.Error(err)
		}
	}()
	config := filepath.Join(r.dir, "waiting.json")
	b, _ := json.Marshal(waitSetup{path, r.dir, r.placement, svc})
	if err = os.WriteFile(config, b, 0600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "node", "waiting-run.mjs", config, exe)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s: %v\n%s", sc.Name, err, out)
	}
	if strings.HasPrefix(string(out), "SKIP ") {
		t.Skip(string(out))
	}
}

type waitFixture struct {
	mu               sync.Mutex
	name, redact     string
	input            json.RawMessage
	entered, release chan struct{}
	path             string
}

func (f *waitFixture) hold(ctx context.Context, name string) {
	f.mu.Lock()
	if f.name != name {
		f.mu.Unlock()
		return
	}
	entered, release := f.entered, f.release
	select {
	case <-entered:
	default:
		close(entered)
	}
	f.mu.Unlock()
	select {
	case <-release:
	case <-ctx.Done():
	}
}
func (f *waitFixture) options(s scenario) []modular.Option {
	opts := []modular.Option{modular.WithLateAnswersStartTurns(true), modular.WithPlugin(modular.Plugin{Name: "waiting-controls", Setup: func(r *modular.Registrar) error {
		if err := r.OnTurnBefore(func(ctx context.Context, _ modular.TurnBefore) (modular.TurnContribution, error) {
			f.hold(ctx, "afterAnswer")
			return modular.TurnContribution{}, nil
		}); err != nil {
			return err
		}
		if err := r.OnToolBefore(func(ctx context.Context, _ modular.ToolBefore) (modular.Gate, error) {
			f.hold(ctx, "beforeGates")
			f.hold(ctx, "beforeHandoff")
			f.mu.Lock()
			defer f.mu.Unlock()
			return modular.Gate{Input: f.input}, nil
		}); err != nil {
			return err
		}
		return r.OnOutput(func(_ context.Context, b modular.OutputBatch) (modular.OutputDecision, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.redact != "" && b.Recipient == f.redact {
				for _, e := range b.Events {
					if e.Type == "inputRequested" || e.Type == "question.open" {
						return modular.OutputDecision{Block: true}, nil
					}
				}
			}
			return modular.OutputDecision{}, nil
		})
	}})}
	if ms := s.Fixture.RequestedApprovalMs; ms > 0 {
		opts = append(opts, modular.WithApprovalRequestTimeout(time.Duration(ms)*time.Millisecond))
	}
	base, err := history.New(filepath.Join(f.path, "sessions"))
	if err != nil {
		panic(err)
	}
	return append(opts, modular.WithHistory(modular.NewHistoryStore(&waitStore{base, filepath.Join(f.path, "commits")}, true, false)))
}

type waitStore struct {
	modular.HistoryBackend
	log string
}
type waitLease struct {
	modular.HistoryLease
	log  string
	size int
}

func (s *waitStore) Acquire(id string) (modular.HistoryLease, error) {
	l, err := s.HistoryBackend.Acquire(id)
	if err != nil {
		return nil, err
	}
	return &waitLease{HistoryLease: l, log: s.log}, nil
}
func (l *waitLease) Load() (modular.SessionRecord, error) {
	s, err := l.HistoryLease.Load()
	if err == nil {
		l.size = len(s.Entries)
	}
	return s, err
}
func (l *waitLease) Save(s modular.SessionRecord) error {
	if err := l.HistoryLease.Save(s); err != nil {
		return err
	}
	if l.size == len(s.Entries) {
		return nil
	}
	batch := []map[string]any{}
	for _, e := range s.Entries[l.size:] {
		batch = append(batch, portable.Entry(e))
	}
	l.size = len(s.Entries)
	f, err := os.OpenFile(l.log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(batch)
}

type waitCommand struct {
	Op, ID, As, Decision, Text string
	Now                        int64
	Present                    bool
	Barrier                    map[string]string
	Change                     struct {
		Setting      modular.Settings
		Registration string
		GateInput    json.RawMessage
		GateView     struct{ Actor string }
		RemoveRight  struct{ Actor, Right string }
	}
}
type waitWorker struct {
	t       *testing.T
	ctx     context.Context
	run     run
	sc      scenario
	clock   *modulartest.ManualClock
	agent   *modular.Agent
	session *modular.Session
	views   map[string]*modular.Session
}

func (w *waitWorker) command(p waitCommand) (any, error) {
	f := w.run.waiting
	view := w.session
	if p.As != "" && p.As != "user" {
		if w.views[p.As] == nil {
			v, err := view.As(p.As)
			if err != nil {
				return nil, err
			}
			w.views[p.As] = v
		}
		view = w.views[p.As]
	}
	switch p.Op {
	case "probe", "open":
		w.clock = modulartest.UseClock(w.t, time.UnixMilli(p.Now))
		sc := w.sc
		if p.Op == "probe" {
			sc.Agent.Durability = modular.Kept
			sc.Agent.Approval = modular.All
			sc.Agent.MaxApprovalWaitMs = new(int64(100))
			sc.Agent.Settings = nil
		}
		sc.Agent.Settings = nil // Record the real settings at session creation, not composition.
		a, err := w.run.agent(w.ctx, sc, nil)
		if err != nil {
			return nil, err
		}
		w.agent = a
		if p.Op == "probe" {
			return a.Declaration(), nil
		}
		if p.ID == "" {
			w.session, err = a.Session(w.ctx, modular.SessionOptions{Actors: sc.Agent.Actors, Settings: w.sc.Agent.Settings})
		} else {
			w.session, err = a.OpenSession(w.ctx, p.ID)
		}
		if err != nil {
			return nil, err
		}
		w.views = map[string]*modular.Session{}
		return map[string]any{"id": w.session.ID(), "declaration": a.Declaration()}, nil
	case "prompt", "wait":
		var res *modular.PromptResult
		if p.Op == "prompt" {
			v, err := view.Prompt(w.ctx, p.Text)
			if err != nil {
				return nil, err
			}
			res = &v
		} else {
			if err := view.WaitIdle(w.ctx); err != nil {
				return nil, err
			}
			v, err := view.LastTurn(w.ctx)
			if err != nil {
				return nil, err
			}
			res = v
		}
		return map[string]any{"outcome": res.Outcome.Kind, "text": res.Text, "toolResults": res.ToolResults(), "openToolCalls": append([]string{}, res.OpenToolCalls...)}, nil
	case "poll":
		qs, err := view.Questions(w.ctx, modular.QuestionsOptions{Present: p.Present})
		if err != nil {
			return nil, err
		}
		out := []map[string]any{}
		for _, q := range qs {
			d := map[string]any{"id": q.ID, "kind": q.Kind, "question": q.Question, "call": q.Call, "approvalWait": q.ApprovalWait}
			if q.Deadline != nil {
				d["deadline"] = q.Deadline.UnixMilli()
			}
			out = append(out, d)
		}
		return out, nil
	case "answer":
		answer := modular.Allow()
		if p.Decision == "decline" {
			answer = modular.Decline("")
		}
		err := view.Answer(w.ctx, p.ID, answer)
		var e *modular.Error
		if errors.As(err, &e) && (e.Code == modular.Forbidden || e.Code == modular.NotFound) {
			return false, nil
		}
		return err == nil, err
	case "clock":
		d := time.UnixMilli(p.Now).Sub(w.clock.Now())
		if d < 0 {
			return nil, errors.New("clock moved backwards")
		}
		w.clock.Advance(d)
	case "barrier":
		f.mu.Lock()
		if b := p.Barrier["arm"]; b != "" {
			f.name = b
			f.entered = make(chan struct{})
			f.release = make(chan struct{})
			f.mu.Unlock()
			return nil, nil
		}
		if p.Barrier["release"] == f.name {
			close(f.release)
			f.name = ""
			f.mu.Unlock()
			return nil, nil
		}
		if p.Barrier["reached"] != f.name {
			f.mu.Unlock()
			return nil, errors.New("wrong barrier")
		}
		name, ch := f.name, f.entered
		f.mu.Unlock()
		if name == "afterEffect" { // The counter fixture waits after its atomic rename. The file, not elapsed time, is the barrier.
			tick := time.NewTicker(5 * time.Millisecond)
			defer tick.Stop()
			for {
				if b, _ := os.ReadFile(w.run.countPath()); string(b) == "1" {
					return nil, nil
				}
				select {
				case <-tick.C:
				case <-w.ctx.Done():
					return nil, w.ctx.Err()
				}
			}
		}
		select {
		case <-ch:
		case <-w.ctx.Done():
			return nil, w.ctx.Err()
		}
	case "change":
		if v := p.Change.RemoveRight; v.Actor != "" {
			for _, a := range w.sc.Agent.Actors {
				if a.ID == v.Actor {
					a.Rights = slices.DeleteFunc(slices.Clone(a.Rights), func(r string) bool { return r == v.Right })
					return nil, w.session.Join(w.ctx, a)
				}
			}
			return nil, errors.New("unknown member")
		}
		if v := p.Change.Registration; v != "" {
			_, err := w.session.RunCommand(w.ctx, "changeCounter "+v)
			return nil, err
		}
		for k, v := range p.Change.Setting {
			if err := w.session.SetSetting(w.ctx, k, v); err != nil {
				return nil, err
			}
		}
		f.mu.Lock()
		if p.Change.GateInput != nil {
			f.input = p.Change.GateInput
		}
		if v := p.Change.GateView.Actor; v != "" {
			f.redact = v
		}
		f.mu.Unlock()
	case "close":
		if w.session != nil {
			if err := w.session.Close(w.ctx); err != nil {
				return nil, err
			}
		}
		if w.agent != nil {
			return nil, w.agent.Close(w.ctx)
		}
	default:
		return nil, fmt.Errorf("unknown waiting operation %q", p.Op)
	}
	return nil, nil
}
func TestWaitingScenarioProcess(t *testing.T) {
	file := os.Getenv("MA_GO_WAIT_WORKER")
	if file == "" {
		t.Skip("started by waiting-run.mjs")
	}
	opt, err := load[waitSetup](file)
	if err != nil {
		t.Fatal(err)
	}
	sc, err := load[scenario](opt.Path)
	if err != nil {
		t.Fatal(err)
	}
	w := waitWorker{t: t, ctx: t.Context(), run: run{dir: opt.Dir, placement: opt.Placement, services: opt.Services, waiting: &waitFixture{path: opt.Dir}}, sc: sc}
	dec, enc := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var p waitCommand
		if err := dec.Decode(&p); err == io.EOF {
			return
		} else if err != nil {
			t.Fatal(err)
		}
		value, err := w.command(p)
		reply := map[string]any{"value": value}
		if err != nil {
			reply["error"] = err.Error()
			var e *modular.Error
			if errors.As(err, &e) {
				reply["code"] = e.Code
			}
		}
		if err := enc.Encode(reply); err != nil {
			t.Fatal(err)
		}
		if p.Op == "close" {
			return
		}
	}
}
