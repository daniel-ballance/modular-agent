package harness

import (
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"go.opentelemetry.io/otel/trace"
	"slices"
	"strings"
)

// HasLocalPlugin disambiguates portable job ownership from stdio names.
func (h *Harness) HasLocalPlugin(name string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.plugins[name]
	return ok
}

func (c *client) HasLocalPlugin(name string) bool { return c.h.HasLocalPlugin(name) }

func (c *client) CheckSessionWriter(id string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkWriterLocked()
}

// JobTrace returns the live observation context, not authority to act as a job.
func (c *client) JobTrace(sessionID, jobID string) context.Context {
	s, err := c.find(sessionID)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.jobSpans[jobID]
}

// ObserveJob starts a separate observation for a job restored from history.
func (c *client) ObserveJob(job api.Job) {
	s, err := c.find(job.Session)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.jobSpans[job.ID] == nil {
		s.startJobSpan(telemetry.Scope(context.Background(), job.Session, job.Turn, "", c.h.agentName), job.ID)
	}
}

func (c *client) finishJobLocked(s *session, end api.Entry, contexts ...context.Context) (api.Entry, api.Entry, error) {
	job := api.Decode[api.Job](end.Data)
	next := clone(s.data)
	var admission api.Entry
	var in api.Input
	if job.Report {
		if s.closing || !job.ResultPresent || !c.authorized(s.data, api.JobActor(job.ID), "input") {
			return end, admission, api.ErrJobReportRefused
		}
		// A reported job can be the first work to require the configured model.
		if !slices.ContainsFunc(next.Entries, func(e api.Entry) bool { return e.Kind == "setting" }) {
			appendEntry(&next, api.Entry{Kind: "setting", Data: api.JSON(next.Settings)}, "harness", true)
		}
	}
	end = appendEntry(&next, end, c.owner, true)
	if job.Report {
		in, admission = appendJobReport(&next, end, job, api.ID(), job.Outcome.Result, c.h.parkJobReports)
		if jobCtx := s.jobSpans[end.Job]; jobCtx != nil {
			ctx, admit := telemetry.Start(telemetry.Session(firstContext(contexts), s.id), "modular_agent.input.admit", trace.WithLinks(trace.Link{SpanContext: trace.SpanContextFromContext(jobCtx)}), trace.WithAttributes(telemetry.String("modular_agent.input.id", in.ID)))
			in.TraceContext = telemetry.Inject(ctx)
			defer admit.End()
			contexts = []context.Context{ctx}
		}
	}
	if err := s.commitLocked(next, contexts...); err != nil {
		return end, api.Entry{}, fmt.Errorf("%w: %v", api.ErrJobCommitLost, err)
	}
	if admission.ID != "" && !s.opening && !parked(in) {
		c.enqueueLocked(s, in)
	}
	return end, admission, nil
}

func appendJobReport(next *api.Session, end api.Entry, j api.Job, id string, content api.Content, parked bool) (api.Input, api.Entry) {
	rights := j.Rights
	who := api.JobActor(end.Job)
	taken := "after"
	if parked {
		taken = "proposed"
	}
	in := api.Input{ID: id, Key: who, Actor: who, When: "after", Taken: taken, Parked: &parked, Job: end.Job, JobRights: rights, Content: content, Copies: []string{end.ID}}
	entry := appendEntry(next, api.Entry{Kind: "input.accepted", InputRef: in.ID, Job: end.Job, Actor: j.Actor, Data: api.JSON(in), Copies: in.Copies, Content: content}, "harness", true)
	return in, entry
}

// A reported end and its initial admission are one commit. An erased
// admission still occupies its place, but supplies no runnable content.
func validateJobReports(s api.Session) error {
	entries := s.LiveEntries()
	for i, end := range entries {
		if end.Kind != "job.end" {
			continue
		}
		j := api.Decode[api.Job](end.Data)
		if !j.Report {
			continue
		}
		if !j.ResultPresent || i+1 >= len(entries) {
			return fmt.Errorf("job %s lacks its report admission", end.Job)
		}
		a := entries[i+1]
		if !a.WasKind("input.accepted") || a.Job != end.Job || a.Parent != end.ID || a.InputRef == "" {
			return fmt.Errorf("unmatched job report %s", end.Job)
		}
		if a.IsErased() {
			continue
		}
		in := api.Decode[api.Input](a.Data)
		if in.Key != api.JobActor(end.Job) || in.When != "after" || in.Parked == nil || !portable.EqualJSON(api.JSON(portable.Content(in.Content)), api.JSON(portable.Content(j.Outcome.Result))) {
			return fmt.Errorf("inconsistent job report %s", end.Job)
		}
	}
	return nil
}

// A job actor is never an Interface actor. Its execution rights are derived
// from its start and the current actor chain, not from plugin-supplied data.
func jobAncestors(s api.Session, who, right string) []string {
	if !strings.HasPrefix(who, "job:") {
		return []string{who}
	}
	switch right {
	case "watch", "input", "tools", "jobs", "delegate":
	default:
		return nil
	}
	// Walk backwards so all relations point to earlier work. Invalid or
	// cyclic records leave unresolved identities and grant nothing.
	pending := map[string]bool{who: true}
	var actors []string
	entries := s.LiveEntries()
	for i := len(entries) - 1; i >= 0 && len(pending) != 0; i-- {
		e := entries[i]
		derived := api.JobActor(e.Job)
		if e.Kind != "job.start" || e.Session != s.ID || !pending[derived] {
			continue
		}
		delete(pending, derived)
		job := api.Decode[api.Job](e.Data)
		rights := job.Rights
		if !slices.Contains(rights, right) {
			return nil
		}
		for _, actor := range append([]string{e.Actor}, job.Contributors...) {
			if strings.HasPrefix(actor, "job:") {
				pending[actor] = true
			} else {
				actors = append(actors, actor)
			}
		}
	}
	if len(pending) != 0 {
		return nil
	}
	return actors
}
