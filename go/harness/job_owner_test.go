package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"testing"
)

type jobReportLease struct {
	api.Lease
	saves []api.Session
	err   error
}

func (l *jobReportLease) Save(s api.Session) error {
	l.saves = append(l.saves, s)
	return l.err
}

func TestReportedEndPublishesOneBatch(t *testing.T) {
	for _, fail := range []bool{false, true} {
		h := New()
		c := &client{h: h, owner: "jobs"}
		lease := &jobReportLease{}
		if fail {
			lease.err = errors.New("store did not acknowledge")
		}
		j := api.Job{ID: "job", Session: "session", Actor: "local-user", Owner: "owner", Rights: []string{"input"}, State: "running"}
		s := c.newSessionState(j.Session, "")
		s.data, s.lease, s.running = api.Session{ID: j.Session, Actor: j.Actor}, lease, true
		appendEntry(&s.data, api.Entry{Kind: "setting"}, "harness", true)
		appendEntry(&s.data, api.Entry{Kind: "job.start", Job: j.ID, Actor: j.Actor, Data: api.JSON(j)}, j.Owner, true)
		h.sessions[s.id] = s
		j.State, j.Report, j.ResultPresent = "completed", true, true // Explicit empty content is still a result.
		_, err := c.Record(context.Background(), s.id, api.Entry{Kind: "job.end", Job: j.ID, Actor: j.Actor, Writer: j.Owner, Data: api.JSON(j)})
		if errors.Is(err, api.ErrJobCommitLost) != fail || (err != nil && !fail) || len(lease.saves) != 1 {
			t.Fatalf("failed=%v saves=%d: %v", fail, len(lease.saves), err)
		}
		batch := lease.saves[0].Entries[2:]
		if len(batch) != 2 || batch[0].Kind != "job.end" || batch[1].Kind != "input.accepted" || batch[1].Parent != batch[0].ID {
			t.Fatalf("end and admission not staged together: %v", batch)
		}
		d := api.Decode[map[string]any](api.JSON(portable.Entry(batch[1])["data"]))
		if d["parked"] != false || d["key"] != "job:job" || d["taken"] != "after" || batch[1].Actor != j.Actor || string(api.JSON(d["content"])) != "[]" {
			t.Fatal(d)
		}
		if fail && (len(s.data.Entries) != 2 || len(s.queue) != 0) {
			t.Fatal("unconfirmed store write became visible or runnable")
		}
		if !fail {
			if len(s.data.Entries) != 4 || len(s.queue) != 1 {
				t.Fatal("committed batch not visible and queued")
			}
			in := s.queue[0]
			if in.Actor != api.JobActor(j.ID) {
				t.Fatal("report must act as its job")
			}
			taken, err := s.takeLocked(in, "report-turn")
			if err != nil || taken.Actor != batch[1].Actor || taken.Job != j.ID {
				t.Fatal("taken report lost its admission attribution", taken, err)
			}
		}
	}
}
