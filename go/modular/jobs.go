package modular

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

// JobOwner stops or resumes work registered under its plugin name.
type JobOwner struct {
	Cancel func(context.Context, *Job) error
	Resume func(context.Context, *Job) error
}

type Job struct {
	ID, SessionID, ActorID, Kind, Key string
	Detail                            json.RawMessage
	Started                           bool
	jobs                              *jobAdapter
	trace                             context.Context
}

type JobCalls struct {
	work *ToolContext
	jobs *jobAdapter
}

type jobAdapter struct {
	name   string
	owner  JobOwner
	host   api.API
	server *pluginrpc.Server
	active sync.Map
}

func (j *jobAdapter) local() (api.ExternalJobs, error) {
	value, err := j.host.Get("jobs")
	if err != nil {
		return nil, err
	}
	return value.(api.ExternalJobs), nil
}
func (r *Registrar) Jobs(owner JobOwner) error {
	if owner.Cancel == nil {
		return r.fail(errors.New("job owner needs a cancel handler"))
	}
	if err := r.add("jobs"); err != nil {
		return err
	}
	r.jobOwner = &owner
	return nil
}

func (c JobCalls) Start(ctx context.Context, kind string, detail any, key ...string) (*Job, error) {
	if c.jobs == nil {
		return nil, &Error{Code: NotSupported, Message: "plugin is not a job owner"}
	}
	if kind == "" || len(key) > 1 || len(key) == 1 && key[0] == "" {
		return nil, &Error{Code: InvalidRequest, Message: "invalid job kind or key"}
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return nil, appError(err, InvalidRequest)
	}
	w := c.work
	j := &Job{SessionID: w.SessionID, ActorID: w.ActorID, Kind: kind, Detail: raw, jobs: c.jobs}
	if len(key) == 1 {
		j.Key = key[0]
	}
	err = w.callback(ctx, func(ctx context.Context) error {
		adapter := c.jobs
		if adapter.server != nil {
			params := pluginrpc.Object{"sessionId": w.SessionID, "kind": kind, "detail": raw}
			if j.Key != "" {
				params["key"] = j.Key
			}
			var res struct {
				JobID   string
				Started bool
			}
			if err := adapter.server.Callback(ctx, "host/jobs/start", params, &res); err != nil {
				return err
			}
			j.ID, j.Started = res.JobID, res.Started
		} else {
			jobs, err := adapter.local()
			if err != nil {
				return err
			}
			ex := api.Executing(ctx)
			job, fresh, err := jobs.StartExternal(ctx, api.Job{Session: j.SessionID, Actor: j.ActorID, Turn: ex.Turn, Call: w.CallID, Owner: adapter.name, Kind: kind, Key: j.Key, Detail: raw})
			if err != nil {
				return err
			}
			j.ID, j.Started = job.ID, fresh
		}
		j.trace = telemetry.InTrace(context.Background(), ctx)
		if existing, loaded := adapter.active.LoadOrStore(j.ID, j); loaded {
			j.trace = existing.(*Job).trace
		}
		return nil
	})
	return j, appError(err, InvalidRequest)
}

func (j *Job) Progress(ctx context.Context, content Content) error {
	if _, ok := j.jobs.active.Load(j.ID); !ok {
		return &Error{Code: InvalidRequest, Message: "job has ended"}
	}
	if j.jobs.server != nil {
		return appError(j.jobs.server.JobNotifyContext(telemetry.InTrace(ctx, j.trace), "host/jobs/progress", pluginrpc.Object{"jobId": j.ID, "content": content}), InvalidRequest)
	}
	jobs, err := j.jobs.local()
	if err != nil {
		return appError(err, NotSupported)
	}
	return appError(jobs.ProgressExternal(ctx, j.jobs.name, j.ID, portable.ReadContent(content)), InvalidRequest)
}

func (j *Job) End(ctx context.Context, outcome Outcome, result Content, report bool) error {
	if report && result == nil {
		return &Error{Code: InvalidRequest, Message: "a job report requires a result"}
	}
	packed := map[string]any{"kind": outcome.Kind}
	switch outcome.Kind {
	case "failed":
		packed["error"] = outcome.Error
	case "completed", "cancelled", "outcomeUnknown":
	default:
		return &Error{Code: InvalidRequest, Message: "invalid job outcome"}
	}
	var err error
	if j.jobs.server != nil {
		p := pluginrpc.Object{"jobId": j.ID, "outcome": packed, "report": report}
		if result != nil {
			p["result"] = result
		}
		err = j.jobs.server.JobCall(telemetry.InTrace(ctx, j.trace), "host/jobs/end", p, nil)
	} else {
		var jobs api.ExternalJobs
		jobs, err = j.jobs.local()
		if err == nil {
			var converted api.Content
			if result != nil {
				converted = portable.ReadContent(result)
			}
			err = jobs.EndExternal(ctx, j.jobs.name, j.ID, api.Outcome{Status: outcome.Kind, Error: outcome.Error, Result: converted}, report)
		}
	}
	if err == nil {
		j.jobs.active.Delete(j.ID)
	}
	return appError(err, InvalidRequest)
}

func (j *jobAdapter) cancel(ctx context.Context, id string) error {
	v, ok := j.active.Load(id)
	if !ok {
		return &Error{Code: InvalidRequest, Message: "unknown active job"}
	}
	return j.owner.Cancel(ctx, v.(*Job))
}

func (j *jobAdapter) resume(ctx context.Context, session string) error {
	if j.owner.Resume == nil {
		return nil
	}
	var jobs []*Job
	var local api.ExternalJobs
	if j.server != nil {
		var reply struct {
			Jobs []struct {
				JobID, Kind, Key, ActorID, Cleanup string
				Detail                             json.RawMessage
			}
		}
		if err := j.server.JobCall(ctx, "host/jobs/unfinished", pluginrpc.Object{"sessionId": session}, &reply); err != nil {
			return err
		}
		for _, row := range reply.Jobs {
			if row.Cleanup != "unconfirmed" {
				jobs = append(jobs, &Job{ID: row.JobID, SessionID: session, Kind: row.Kind, Key: row.Key, ActorID: row.ActorID, Detail: row.Detail, jobs: j, Started: true})
			}
		}
	} else {
		var err error
		local, err = j.local()
		if err != nil {
			return err
		}
		rows, err := local.Unfinished(j.name, session)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if !row.CleanupUnconfirmed {
				jobs = append(jobs, &Job{ID: row.ID, SessionID: session, Kind: row.Kind, Key: row.Key, ActorID: row.Actor, Detail: row.Detail, jobs: j, Started: true})
			}
		}
	}
	for _, job := range jobs {
		var err error
		if j.server != nil {
			err = j.server.JobCall(ctx, "host/jobs/resume", pluginrpc.Object{"jobId": job.ID}, nil)
		} else {
			err = local.ResumeExternal(j.name, job.ID)
		}
		if err != nil {
			return err
		}
		job.trace = telemetry.InTrace(context.Background(), ctx)
		j.active.Store(job.ID, job)
		if err = j.owner.Resume(ctx, job); err != nil {
			return err
		}
	}
	return nil
}

// CancelJob requests cancellation and waits for the owner's committed end.
func (s *Session) CancelJob(ctx context.Context, id string) error {
	if err := s.require(ctx, "cancel"); err != nil {
		return err
	}
	v, err := s.agent.a.Get("jobs")
	if err == nil {
		err = v.(api.Jobs).Cancel(s.ctx(ctx), s.id, id)
	}
	if errors.Is(err, api.ErrJobNotFound) {
		return appError(err, NotFound)
	}
	return appError(err, Lost)
}
