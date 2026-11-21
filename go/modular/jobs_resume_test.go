package modular_test

import (
	"context"
	"errors"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestJobOwnerResumesBeforeReopenReturns(t *testing.T) {
	ctx := t.Context()
	started, resumed := make(chan string, 1), make(chan string, 1)
	tool := modular.NewTool("background", "Start work outside a turn.", func(ctx context.Context, _ struct{}, c *modular.ToolContext) (string, error) {
		j, err := c.Jobs.Start(ctx, "background", nil, "stable-key")
		if err != nil {
			return "", err
		}
		started <- j.ID
		return "started", nil
	})
	p := modular.Plugin{Name: "worker", Setup: func(r *modular.Registrar) error {
		return errors.Join(r.Tool(tool), r.Jobs(modular.JobOwner{
			Cancel: func(ctx context.Context, j *modular.Job) error {
				return j.End(ctx, modular.Outcome{Kind: "cancelled"}, nil, false)
			},
			Resume: func(ctx context.Context, j *modular.Job) error {
				resumed <- j.ID
				return j.End(ctx, modular.Outcome{Kind: "completed"}, modular.Text("finished"), false)
			},
		}))
	}}
	a := modulartest.Agent(t, modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()), modular.WithPlugin(p))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id := s.ID()
	if got, err := s.CallTool(ctx, "background", struct{}{}); err != nil || got.Text() != "started" {
		t.Fatalf("call: %+v %v", got, err)
	}
	job := <-started
	a = modulartest.Restart(t, a)
	s, err = a.OpenSession(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case j := <-resumed:
		if j != job {
			t.Fatalf("resumed %q, expected %q", j, job)
		}
	default:
		t.Fatal("resume not dispatched before reopen returned")
	}
	entries, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e["kind"] == "jobEnded" {
			return
		}
	}
	t.Fatal("resumed job did not commit its end")
}
