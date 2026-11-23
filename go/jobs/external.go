package jobs

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

func (m *Manager) StartExternal(ctx context.Context, j api.Job) (api.Job, bool, error) {
	return m.start(ctx, j, nil)
}

func (m *Manager) Unfinished(owner, session string) ([]api.Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.open[session]; !ok || m.stopped {
		return nil, errors.New("session is not open")
	}
	list, err := m.List(session)
	if err != nil {
		return nil, err
	}
	out := []api.Job{}
	for _, j := range list {
		if j.Owner == owner && j.State == "running" {
			out = append(out, j)
		}
	}
	return out, nil
}

func (m *Manager) checkWriter(session string) error {
	if a, ok := m.a.(interface{ CheckSessionWriter(string) error }); ok {
		if err := a.CheckSessionWriter(session); err != nil {
			return errors.Join(api.ErrJobCommitLost, err)
		}
	}
	return nil
}

func (m *Manager) findExternalLocked(owner, id string) (api.Job, error) {
	if !m.stopped {
		for session := range m.open {
			if j, err := m.lookup(session, id); err == nil && j.Owner == owner {
				return j, m.checkWriter(session)
			}
		}
	}
	return api.Job{}, errors.New("job of this plugin not found")
}

// ExternalTrace resolves the live observation only for this job owner.
func (m *Manager) ExternalTrace(owner, id string) context.Context {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, err := m.findExternalLocked(owner, id)
	if err != nil || j.State != "running" {
		return nil
	}
	return m.jobTrace(j)
}

func (m *Manager) jobTrace(j api.Job) context.Context {
	if h, ok := m.a.(interface {
		JobTrace(string, string) context.Context
	}); ok {
		return h.JobTrace(j.Session, j.ID)
	}
	return nil
}

func (m *Manager) ResumeExternal(owner, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, err := m.findExternalLocked(owner, id)
	if err != nil {
		return err
	}
	key := ref{j.Session, id}
	if m.open[j.Session] || j.State != "running" || j.CleanupUnconfirmed || m.remoteRuns[key] || m.cancelling[key] != nil || !m.a.Authorize(j.Session, api.JobActor(j.ID), "jobs") {
		return errors.New("job cannot be resumed")
	}
	if h, ok := m.a.(interface{ ObserveJob(api.Job) }); ok {
		h.ObserveJob(j)
	}
	m.launch(j, nil)
	return nil
}

func (m *Manager) ProgressExternal(ctx context.Context, owner, id string, content api.Content) error {
	m.mu.Lock()
	j, err := m.findExternalLocked(owner, id)
	active := j.State == "running" && !j.CleanupUnconfirmed && m.workers[ref{j.Session, id}] != nil
	if active {
		if scope := m.jobTrace(j); scope != nil {
			ctx = telemetry.InTrace(ctx, scope)
		}
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if active {
		m.emit(ctx, "job.progress", j, api.JSON(struct {
			JobID   string      `json:"jobId"`
			Content api.Content `json:"content"`
		}{id, content}))
	}
	return nil
}

func (m *Manager) EndExternal(ctx context.Context, owner, id string, outcome api.Outcome, report bool) error {
	m.mu.Lock()
	j, err := m.findExternalLocked(owner, id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	outcome, tooLarge := boundJobOutcome(outcome, report)
	if j.State != "running" {
		m.mu.Unlock()
		if j.State != "erased" && j.State == outcome.Status && j.Report == report && j.Outcome.Error == outcome.Error &&
			j.ResultPresent == (outcome.Result != nil) && portable.EqualJSON(api.JSON(portable.Content(j.Outcome.Result)), api.JSON(portable.Content(outcome.Result))) {
			if tooLarge {
				return api.ErrResultTooLarge
			}
			return nil
		}
		return errors.New("conflicting or erased job end")
	}
	if j.CleanupUnconfirmed || !m.a.Authorize(j.Session, api.JobActor(j.ID), "jobs") {
		m.mu.Unlock()
		return errors.New("job end refused")
	}
	key := ref{j.Session, id}
	j, err = m.endLocked(ctx, j, outcome, report)
	if err == nil {
		m.release(key)
	}
	m.mu.Unlock()
	if err == nil {
		m.emit(ctx, "job.ended", j, api.JSON(j))
		if tooLarge {
			return api.ErrResultTooLarge
		}
	}
	return err
}
