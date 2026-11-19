// Package jobs records session-owned work. Its owner plugin decides recovery.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"slices"
	"strings"
	"sync"
)

type ref struct{ session, job string }
type worker struct {
	// nil for work running in a remote plugin
	cancel      context.CancelCauseFunc
	done        chan struct{}
	interrupted bool
	finishing   bool
}
type cancellation struct {
	done chan struct{}
	err  error
}
type Manager struct {
	a          api.API
	mu         sync.Mutex
	workers    map[ref]*worker
	remoteRuns map[ref]bool // a job can start or resume only once on this host's registered connection
	cancelling map[ref]*cancellation
	open       map[string]bool // value is whether the session is closing
	stopped    bool
}

func Plugin() api.Plugin {
	return api.Plugin{Name: "jobs", Setup: func(a api.API) error {
		m := &Manager{a: a, workers: map[ref]*worker{}, remoteRuns: map[ref]bool{}, cancelling: map[ref]*cancellation{}, open: map[string]bool{}}
		if err := a.Provide("jobs", m); err != nil {
			return err
		}
		if err := a.RegisterCommand("jobs", func(ctx context.Context, id string, _ []string) (string, error) {
			list, err := m.List(id)
			return string(api.JSON(list)), err
		}); err != nil {
			return err
		}
		if err := a.RegisterCommand("job-cancel", func(ctx context.Context, id string, args []string) (string, error) {
			if len(args) != 1 {
				return "", errors.New("usage: /job-cancel job-id")
			}
			return "Job cancelled.", m.Cancel(ctx, id, args[0])
		}); err != nil {
			return err
		}
		if err := a.Handle("session.start", "first", func(ctx context.Context, v any) (api.Decision, error) {
			m.mu.Lock()
			m.open[v.(api.Session).ID] = false
			m.mu.Unlock()
			return api.Decision{}, nil
		}); err != nil {
			return err
		}
		if err := a.Handle("process.stop", "", func(ctx context.Context, _ any) (api.Decision, error) {
			m.stop(ctx, "", true)
			return api.Decision{}, nil
		}); err != nil {
			return err
		}
		for _, point := range []string{"session.end", "session.stop"} {
			if err := a.Handle(point, "first", func(ctx context.Context, v any) (api.Decision, error) {
				m.stop(ctx, v.(string), point == "session.stop")
				return api.Decision{}, nil
			}); err != nil {
				return err
			}
		}
		return nil
	}}
}

func (m *Manager) List(id string) ([]api.Job, error) {
	s, err := m.a.Snapshot(id)
	if err != nil {
		return nil, err
	}
	return readJobs(id, s.LiveEntries()), nil
}

// Active lists only unfinished jobs and distinguishes attached work from jobs
// waiting to be taken up after a reopen.
func (m *Manager) Active(id string) ([]api.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	list, err := m.List(id)
	list = slices.DeleteFunc(list, func(j api.Job) bool { return j.State != "running" })
	for i, j := range list {
		if j.CleanupUnconfirmed {
			list[i].State = "cleanupUnconfirmed"
		} else if m.workers[ref{id, j.ID}] == nil {
			list[i].State = "unfinished"
		}
	}
	return list, err
}

func readJobs(session string, entries []api.Entry) []api.Job {
	by := map[string]api.Job{}
	var order []string
	for _, e := range entries {
		switch e.Kind {
		case "job.start":
			j := api.Decode[api.Job](e.Data)
			if j.Session != session || j.ID == "" {
				continue
			} // a fork's copies are provenance
			j.StartEntry = e.ID
			if j.Call == "" {
				j.Call = e.Call
			}
			if _, ok := by[j.ID]; !ok {
				order = append(order, j.ID)
			}
			by[j.ID] = j
		case "job.cleanup":
			if j, ok := by[e.Job]; ok && j.State == "running" {
				j.CleanupUnconfirmed = true
				by[e.Job] = j
			}
		case "job.end":
			end := api.Decode[api.Job](e.Data)
			if j, ok := by[end.ID]; ok && end.Session == session {
				j.State, j.Outcome, j.Report, j.ResultPresent = end.State, end.Outcome, end.Report, end.ResultPresent || end.Outcome.Result != nil
				j.CleanupUnconfirmed = false
				by[j.ID] = j
			}
		case "erasure", "erased":
			id := e.Job
			if e.OriginalKind == "job.start" && id != "" && e.Writer != "" && e.JobKey != "" {
				if _, exists := by[id]; !exists {
					order = append(order, id)
				}
				by[id] = api.Job{ID: id, Key: e.JobKey, Owner: e.Writer, Session: session, State: "erased"}
			}
			if id == "" && e.OriginalKind == "job.end" {
				// Earlier Go stores dropped the job identity from tombstones.
				id, _ = strings.CutPrefix(e.ID, "job-end-")
			}
			if j, ok := by[id]; ok && (e.OriginalKind == "job.end" || e.OriginalKind == "job.start") {
				j.State, j.Report, j.Outcome, j.Detail = "erased", false, api.Outcome{}, nil
				j.CleanupUnconfirmed = false
				by[j.ID] = j
			}
		}
	}
	out := make([]api.Job, 0, len(order))
	for _, id := range order {
		out = append(out, by[id])
	}
	return out
}

func (m *Manager) Start(ctx context.Context, j api.Job, run func(context.Context) api.Outcome) (api.Job, error) {
	j, _, err := m.start(ctx, j, run)
	return j, err
}
func (m *Manager) start(ctx context.Context, j api.Job, run func(context.Context) api.Outcome) (api.Job, bool, error) {
	if err := ctx.Err(); err != nil {
		return j, false, err
	}
	if j.Owner == "" || j.Kind == "" || !m.a.Authorize(j.Session, j.Actor, "jobs") {
		return j, false, errors.New("job start refused")
	}
	j.Contributors = nil
	for _, who := range api.JobContributors(ctx) {
		if who == "" || who == j.Actor {
			continue
		}
		if !m.a.Authorize(j.Session, who, "jobs") {
			return j, false, errors.New("job start refused for input contributor")
		}
		j.Contributors = append(j.Contributors, who)
	}
	j.Rights = []string{}
	for _, right := range api.Rights {
		if m.a.Authorize(j.Session, j.Actor, right) && !slices.ContainsFunc(j.Contributors, func(who string) bool { return !m.a.Authorize(j.Session, who, right) }) {
			j.Rights = append(j.Rights, right)
		}
	}
	m.mu.Lock()
	var fresh bool
	defer func() {
		m.mu.Unlock()
		if fresh {
			m.emit(ctx, "job.started", j, api.JSON(j))
		}
	}()
	if closing, open := m.open[j.Session]; m.stopped || !open || closing {
		return j, false, errors.New("session is not accepting new jobs")
	}
	snap, err := m.a.Snapshot(j.Session)
	if err != nil {
		return j, false, err
	}
	if j.Key != "" {
		for _, old := range readJobs(j.Session, snap.LiveEntries()) {
			if old.Owner == j.Owner && old.Key == j.Key {
				return old, false, nil
			}
		}
	}
	if j.Call == "" {
		j.Call = api.Executing(ctx).Call.ID
	}
	var copies []string
	if j.Call != "" {
		for _, e := range snap.Branch() {
			if (e.Kind == "tool.call" || e.Kind == "tool.started") && e.Call == j.Call {
				copies = append(copies, e.ID)
			}
		}
	}
	j.ID, j.State = api.ID(), "running"
	j.StartEntry = j.ID
	if _, err := m.a.Record(ctx, j.Session, api.Entry{Copies: copies, ID: j.ID, Kind: "job.start", Turn: j.Turn, Call: j.Call, Job: j.ID, Actor: j.Actor, Writer: j.Owner, Data: api.JSON(j)}); err != nil {
		return j, false, err
	}
	m.launch(j, run)
	fresh = true
	return j, true, nil
}
func (m *Manager) Recover(ctx context.Context, j api.Job, run func(context.Context) api.Outcome) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if closing, open := m.open[j.Session]; m.stopped || !open || closing {
		return errors.New("session is not accepting jobs")
	}
	old, err := m.lookup(j.Session, j.ID)
	if err != nil || old.Owner != j.Owner {
		return errors.New("unfinished job not found")
	}
	if old.State != "running" || old.CleanupUnconfirmed || m.workers[ref{j.Session, j.ID}] != nil {
		return errors.New("job cannot be resumed")
	}
	old.Report = j.Report
	m.launch(old, run)
	return nil
}
func (m *Manager) launch(j api.Job, run func(context.Context) api.Outcome) {
	key := ref{j.Session, j.ID}
	w := &worker{done: make(chan struct{})}
	m.workers[key] = w
	if run == nil {
		m.remoteRuns[key] = true
		return
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	w.cancel = cancel
	go func() {
		defer cancel(nil)
		var out api.Outcome
		func() {
			defer func() {
				if p := recover(); p != nil {
					out = api.Outcome{Status: "failed", Error: fmt.Sprintf("job panic: %v", p)}
				}
			}()
			out = run(ctx)
		}()
		m.mu.Lock()
		w.finishing = true
		if !w.interrupted {
			if ctx.Err() != nil && out.Status != "completed" {
				out = api.Outcome{Status: "cancelled", Error: "Job cancelled"}
			}
			var err error
			if j.Report && out.Result == nil {
				out.Result = api.Content{} // an explicit empty result for native jobs
			}
			j, err = m.endLocked(j, out, j.Report)
			if errors.Is(err, api.ErrJobReportRefused) {
				j, err = m.endLocked(j, out, false)
			}
			m.mu.Unlock()
			if err == nil {
				m.emit(context.Background(), "job.ended", j, api.JSON(j))
			}
			m.mu.Lock()
		}
		m.release(key)
		m.mu.Unlock()
	}()
}
func (m *Manager) release(key ref) {
	if w := m.workers[key]; w != nil {
		delete(m.workers, key)
		close(w.done)
	}
}
func (m *Manager) endLocked(j api.Job, out api.Outcome, report bool) (api.Job, error) {
	switch out.Status {
	case "completed", "failed", "cancelled", "outcomeUnknown":
	default:
		out.Status = "failed"
	}
	j.Outcome, j.State, j.Report, j.ResultPresent = out, out.Status, report, out.Result != nil
	j.CleanupUnconfirmed = false
	_, err := m.a.Record(context.Background(), j.Session, api.Entry{ID: "job-end-" + j.ID, Kind: "job.end", Turn: j.Turn, Job: j.ID, Actor: j.Actor, Writer: j.Owner, Copies: append([]string{j.StartEntry}, out.Copies...), Data: api.JSON(j)})
	return j, err
}
func (m *Manager) emit(ctx context.Context, kind string, j api.Job, data []byte) {
	m.a.Emit(ctx, api.Event{Kind: kind, Session: j.Session, Turn: j.Turn, Call: j.Call, Actor: j.Actor, Data: data})
}
func (m *Manager) lookup(session, id string) (api.Job, error) {
	list, err := m.List(session)
	if err != nil {
		return api.Job{}, err
	}
	for _, j := range list {
		if j.ID == id {
			return j, nil
		}
	}
	return api.Job{}, api.ErrJobNotFound
}
func (m *Manager) Wait(ctx context.Context, id, job string) (api.Job, error) {
	m.mu.Lock()
	w := m.workers[ref{id, job}]
	m.mu.Unlock()
	if w != nil {
		select {
		case <-ctx.Done():
			return api.Job{}, ctx.Err()
		case <-w.done:
		}
	}
	j, err := m.lookup(id, job)
	if err == nil && j.State == "running" {
		err = errors.New("job awaits its owner to recover")
	}
	return j, err
}
func (m *Manager) Cancel(ctx context.Context, id, job string) error {
	if !m.a.Authorize(id, api.Acting(ctx), "cancel") {
		return errors.New("job cancel refused")
	}
	return m.cancelJob(ctx, id, job, true)
}
func (m *Manager) cancelJob(ctx context.Context, id, job string, explicit bool) error {
	key := ref{id, job}
	m.mu.Lock()
	w := m.workers[key]
	if w != nil && w.cancel != nil {
		if !w.finishing {
			w.cancel(context.Canceled)
		}
		m.mu.Unlock()
		_, err := m.Wait(ctx, id, job)
		return err
	}
	j, err := m.lookup(id, job)
	if err != nil || j.State != "running" {
		m.mu.Unlock()
		return err
	}
	cancel := m.remoteCanceller(j.Owner)
	if m.stopped || j.CleanupUnconfirmed && cancel != nil {
		m.mu.Unlock()
		return api.ErrJobCleanupLost
	}
	if cancel == nil && explicit && m.ownerGone(j.Owner) {
		j, err = m.endLocked(j, api.Outcome{Status: "cancelled"}, false)
		if err == nil {
			m.release(key)
		}
		m.mu.Unlock()
		if err == nil {
			m.emit(ctx, "job.ended", j, api.JSON(j))
		}
		return err
	}
	if cancel == nil && !m.remoteRuns[key] {
		m.mu.Unlock()
		return errors.New("job awaits owner recovery")
	}
	if c := m.cancelling[key]; c != nil {
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.done:
			return c.err
		}
	}
	c := &cancellation{done: make(chan struct{})}
	m.cancelling[key] = c
	m.mu.Unlock()
	if cancel != nil {
		_ = cancel(ctx, job)
	}
	m.mu.Lock()
	if current, e := m.lookup(id, job); e == nil && current.State != "running" {
		err = nil // the owner recorded the result even if the answer was lost
	} else {
		err = api.ErrJobCleanupLost
		if _, open := m.open[id]; open && !m.stopped {
			if _, recordErr := m.a.Record(context.Background(), id, api.Entry{Kind: "job.cleanup", Job: job}); recordErr != nil {
				err = errors.Join(err, recordErr)
			}
		}
		m.release(key)
	}
	c.err = err
	delete(m.cancelling, key)
	close(c.done)
	m.mu.Unlock()
	return err
}
func (m *Manager) ownerGone(owner string) bool {
	v, err := m.a.Get("job-owner-present")
	if err == nil && v.(func(string) bool)(owner) {
		return false
	}
	// A native owner is present if it has a registered plugin name.
	if local, ok := m.a.(interface{ HasLocalPlugin(string) bool }); ok {
		return !local.HasLocalPlugin(owner)
	}
	return true
}

func (m *Manager) remoteCanceller(owner string) api.JobCanceller {
	lookup, err := m.a.Get("job-owner-lookup")
	if err != nil {
		return nil
	}
	return lookup.(api.JobOwnerLookup)(owner)
}
func (m *Manager) stop(ctx context.Context, id string, interrupt bool) {
	m.mu.Lock()
	if id == "" {
		m.stopped = true
	} else if interrupt {
		delete(m.open, id)
	} else {
		m.open[id] = true
	}
	var done []chan struct{}
	for key, w := range m.workers {
		if id != "" && key.session != id {
			continue
		}
		if w.cancel == nil {
			if interrupt && !w.finishing {
				m.release(key)
			}
			continue
		}
		if !w.finishing {
			w.interrupted = interrupt
			cause := error(context.Canceled)
			if interrupt {
				cause = api.ErrProcessStopped
			}
			w.cancel(cause)
		}
		done = append(done, w.done)
	}
	m.mu.Unlock()
	for _, ch := range done {
		<-ch
	}
	if !interrupt {
		list, _ := m.List(id)
		for _, j := range list {
			if j.State == "running" {
				_ = m.cancelJob(ctx, id, j.ID, false)
			}
		}
		m.mu.Lock()
		delete(m.open, id)
		for key := range m.workers {
			if key.session == id {
				m.release(key)
			}
		}
		m.mu.Unlock()
	}
}
