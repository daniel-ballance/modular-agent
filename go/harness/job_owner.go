package harness

import (
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
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
		if span := s.jobSpans[end.Job]; span != nil {
			ctx, admit := telemetry.Start(telemetry.Session(firstContext(contexts), s.id), "modular_agent.input.admit", trace.WithLinks(trace.Link{SpanContext: span.SpanContext()}), trace.WithAttributes(telemetry.String("modular_agent.input.id", in.ID)))
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
	if rights == nil {
		rights = []string{"watch"}
	}
	who := api.JobActor(end.Job)
	taken := "after"
	if parked {
		taken = "proposed"
	}
	in := api.Input{ID: id, Key: who, Actor: who, When: "after", Taken: taken, Parked: &parked, Job: end.Job, JobRights: rights, Content: content, Copies: []string{end.ID}}
	entry := appendEntry(next, api.Entry{Kind: "input.accepted", Job: end.Job, Actor: j.Actor, Data: api.JSON(in), Copies: in.Copies, Content: content}, "harness", true)
	return in, entry
}

// Older writers could commit the end and crash before admitting its report.
// Never reschedule an already admitted or taken report while repairing it.
func (c *client) repairJobReportsLocked(s *session) error {
	next := clone(s.data)
	for _, end := range s.data.LiveEntries() {
		if end.Kind != "job.end" {
			continue
		}
		report := api.Decode[api.Job](end.Data)
		if !report.Report || (!report.ResultPresent && report.Outcome.Result == nil) {
			continue
		}
		key := api.JobActor(end.Job)
		var taken *api.Entry
		matched := false
		for _, e := range next.LiveEntries() {
			if e.WasKind("input.accepted") && (e.Job == end.Job || (!e.IsErased() && api.Decode[api.Input](e.Data).Key == key)) {
				matched = true
				break
			}
			if e.WasKind("input") && (e.Job == end.Job || e.InputKey == key) {
				copy := e
				taken = &copy
			}
		}
		if matched || (taken != nil && (taken.IsErased() || taken.InputID() == "")) {
			continue
		}
		for _, start := range next.LiveEntries() {
			if start.Kind != "job.start" || start.Job != end.Job {
				continue
			}
			j := api.Decode[api.Job](start.Data)
			if taken != nil {
				appendJobReport(&next, end, j, taken.InputID(), taken.Content, false)
			} else {
				appendJobReport(&next, end, j, api.ID(), report.Outcome.Result, true)
			}
			break
		}
	}
	if len(next.Entries) == len(s.data.Entries) {
		return nil
	}
	return s.commitLocked(next)
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
		if rights == nil {
			rights = []string{"watch"}
		}
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
