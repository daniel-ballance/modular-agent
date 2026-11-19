package pluginrpc

import (
	"context"
	"errors"
	"modular/api"
	"time"
)

// The registered name stays reserved even if the process dies.
func (h *host) registeredPlugin(name string) *remote {
	h.jobOwnersMu.RLock()
	defer h.jobOwnersMu.RUnlock()
	return h.jobOwners[name]
}

func (h *host) jobOwner(name string) *remote {
	r := h.registeredPlugin(name)
	if r == nil || !r.active.Load() {
		return nil
	}
	return r
}

func (h *host) jobCanceller(name string) api.JobCanceller {
	r := h.jobOwner(name)
	if r == nil {
		return nil
	}
	return func(ctx context.Context, id string) error {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return r.peer.Call(ctx, "jobs/cancel", object{"jobId": id}, nil)
	}
}

func (r *remote) jobCallback(ctx context.Context, method string, v object, notification bool) (any, error) {
	if r.host.jobOwner(r.reg.Name) != r {
		return nil, fault("invalid_request", "plugin has no unique job owner name")
	}
	cap, err := r.host.a.Get("jobs")
	if err != nil {
		return nil, fault("not_supported", "jobs capability is unavailable")
	}
	jobs, ok := cap.(api.ExternalJobs)
	if !ok {
		return nil, fault("not_supported", "jobs capability is unavailable")
	}
	invalid := func(err error) (any, error) {
		if err != nil {
			if errors.Is(err, api.ErrJobCommitLost) {
				return nil, fault("lost", err.Error())
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, err
			}
			return nil, fault("invalid_request", err.Error())
		}
		return object{}, nil
	}
	owner, id := r.reg.Name, str(v, "jobId")
	switch method {
	case "host/jobs/start":
		parent, ok := r.peer.requestParent(ctx, mustJSON(v["parentRequestId"]))
		if !ok {
			return nil, fault("invalid_request", "job start needs a live parent request")
		}
		w, ok := parent.Value(workKey{}).(work)
		if !ok || w.session == "" || w.actor == "" || !r.host.a.Authorize(w.session, w.actor, "jobs") ||
			(has(v, "sessionId") && str(v, "sessionId") != w.session) {
			return nil, fault("invalid_request", "job start needs authorized parent work in the session")
		}
		kind := str(v, "kind")
		_, hasDetail := v["detail"]
		if kind == "" || !hasDetail || (has(v, "key") && str(v, "key") == "") {
			return nil, fault("invalid_request", "job start needs kind, detail and a valid optional key")
		}
		ex := api.Executing(parent)
		j := api.Job{Session: w.session, Actor: w.actor, Turn: ex.Turn, Call: w.call.ID, Owner: owner, Kind: kind, Key: str(v, "key"), Detail: mustJSON(v["detail"])}
		linked, cancel := context.WithCancel(parent)
		defer cancel()
		stop := context.AfterFunc(ctx, cancel)
		defer stop()
		if ctx.Err() != nil {
			cancel()
		}
		j, fresh, err := jobs.StartExternal(linked, j)
		if err != nil {
			return invalid(err)
		}
		return object{"jobId": j.ID, "started": fresh}, nil
	case "host/jobs/unfinished":
		if has(v, "parentRequestId") {
			return nil, fault("invalid_request", "unfinished is session-scoped, not parent-scoped")
		}
		list, err := jobs.Unfinished(owner, str(v, "sessionId"))
		if err != nil {
			return invalid(err)
		}
		out := make([]object, 0, len(list))
		for _, j := range list {
			item := object{"jobId": j.ID, "kind": j.Kind, "actorId": j.Actor, "detail": j.Detail}
			if j.Key != "" {
				item["key"] = j.Key
			}
			if j.CleanupUnconfirmed {
				item["cleanup"] = "unconfirmed"
			}
			out = append(out, item)
		}
		return object{"jobs": out}, nil
	case "host/jobs/resume", "host/jobs/end", "host/jobs/progress":
		if id == "" || has(v, "sessionId") || has(v, "parentRequestId") {
			return nil, fault("invalid_request", "request must name a job of this plugin")
		}
		switch method {
		case "host/jobs/resume":
			return invalid(jobs.ResumeExternal(owner, id))
		case "host/jobs/progress":
			if _, ok := v["content"].([]any); !notification || !ok {
				return nil, fault("invalid_request", "job progress must be a notification with content")
			}
			return invalid(jobs.ProgressExternal(ctx, owner, id, contentIn(v["content"])))
		case "host/jobs/end":
			outcome := asObject(v["outcome"])
			kind := str(outcome, "kind")
			report, ok := v["report"].(bool)
			_, hasError := outcome["error"].(string)
			valid := kind == "failed" && len(outcome) == 2 && hasError ||
				len(outcome) == 1 && (kind == "completed" || kind == "cancelled" || kind == "outcomeUnknown")
			if !ok || !valid {
				return nil, fault("invalid_request", "invalid job outcome or report flag")
			}
			var result api.Content
			if raw, present := v["result"]; present {
				if _, ok := raw.([]any); !ok {
					return nil, fault("invalid_request", "invalid job result content")
				}
				result = contentIn(raw)
			} else if report {
				return nil, fault("invalid_request", "a job report requires a result")
			}
			return invalid(jobs.EndExternal(ctx, owner, id, api.Outcome{Status: kind, Error: str(outcome, "error"), Result: result}, report))
		}
	}
	return nil, unknownMethod(method)
}
