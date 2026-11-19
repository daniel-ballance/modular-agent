package jobs_test

import (
	"context"
	"modular/api"
	"modular/fake"
	"modular/internal/runtimetest"
	"modular/vanilla"
	"path/filepath"
	"testing"
	"time"
)

func TestJobStartRequiresJobsRightNotTools(t *testing.T) {
	root := t.TempDir()
	h, err := vanilla.New(vanilla.Options{Project: root, History: t.TempDir(), Provider: fake.New().Plugin(), Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	a := h.API()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id, err := a.New(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := a.Get("jobs")
	jobs := v.(api.Jobs)
	for _, right := range []string{"tools", "jobs"} {
		if err := a.Grant(ctx, id, api.Actor{ID: right + "-only", Kind: "user", Rights: []string{right}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := jobs.Start(ctx, api.Job{Session: id, Actor: "tools-only", Owner: "test", Kind: "test"}, func(context.Context) api.Outcome {
		t.Error("tools right alone started a job")
		return api.Outcome{Status: "failed"}
	}); err == nil {
		t.Error("tools right alone authorized a job")
	}
	job, err := jobs.Start(ctx, api.Job{Session: id, Actor: "jobs-only", Owner: "test", Kind: "test"}, func(context.Context) api.Outcome {
		return api.Outcome{Status: "completed"}
	})
	if err != nil {
		t.Fatal(err)
	}
	if done, err := jobs.Wait(ctx, id, job.ID); err != nil || done.State != "completed" {
		t.Fatal(done, err)
	}
}

func TestJobReportUsesOnlyTheRecordedResult(t *testing.T) {
	for _, result := range []string{"", "partial result"} {
		t.Run("result="+result, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			project := t.TempDir()
			provider := fake.New(fake.Script{Response: api.Response{Content: api.Text("handled"), Stop: "finished"}})
			h, err := vanilla.New(vanilla.Options{Project: project, History: t.TempDir(), Provider: provider.Plugin(), Model: "fake"})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			a := h.API()
			id, err := a.New(ctx, project)
			if err != nil {
				t.Fatal(err)
			}
			capability, err := a.Get("jobs")
			if err != nil {
				t.Fatal(err)
			}
			jobs := capability.(api.Jobs)
			job, err := jobs.Start(ctx, api.Job{Session: id, Actor: "local-user", Owner: "test", Kind: "test", Report: true}, func(context.Context) api.Outcome {
				out := api.Outcome{Status: "failed", Error: "diagnostic, not result"}
				if result != "" {
					out.Result = api.Text(result)
				}
				return out
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := jobs.Wait(ctx, id, job.ID); err != nil {
				t.Fatal(err)
			}
			if out, err := a.Wait(ctx, id); err != nil || out.Status != "completed" {
				t.Fatal(out, err)
			}
			snap, err := a.Snapshot(id)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range snap.Branch() {
				if entry.Kind == "input" && entry.InputKey == "job:"+job.ID {
					wantParts := 0
					if result != "" {
						wantParts = 1
					}
					if got := entry.Content.Text(); got != result || len(entry.Content) != wantParts {
						t.Fatalf("job report = %q, want only %q", got, result)
					}
					return
				}
			}
			t.Fatal("missing keyed job report")
		})
	}
}

func TestProcessStopLeavesJobForItsOwnerAndKeyedStartIsOnce(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		options := vanilla.Options{History: filepath.Join(root, "history"), Runtime: runtimetest.Plugin(t), Provider: fake.New().Plugin(), Model: "fake"}
		h, err := vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		a := h.API()
		id, _ := a.New(context.Background(), root)
		v, _ := a.Get("jobs")
		jobs := v.(api.Jobs)
		started := make(chan struct{})
		job, err := jobs.Start(context.Background(), api.Job{Session: id, Key: "one", Actor: "local-user", Owner: "owner", Kind: "test"}, func(ctx context.Context) api.Outcome {
			close(started)
			<-ctx.Done()
			return api.Outcome{Status: "cancelled"}
		})
		if err != nil {
			t.Fatal(err)
		}
		<-started
		if err = h.Close(); err != nil {
			t.Fatal(err)
		}
		h, err = vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a = h.API()
		if err = a.Open(context.Background(), id); err != nil {
			t.Fatal(err)
		}
		v, _ = a.Get("jobs")
		jobs = v.(api.Jobs)
		list, _ := jobs.List(id)
		if len(list) != 1 || list[0].State != "running" {
			t.Fatal("Harness ended an interrupted owner's job", list)
		}
		if err = jobs.Recover(context.Background(), list[0], func(context.Context) api.Outcome {
			return api.Outcome{Status: "completed", Result: api.Text("owner resumed"), Usage: api.Usage{Input: 7, Output: 2}}
		}); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		done, err := jobs.Wait(ctx, id, job.ID)
		if err != nil || done.State != "completed" {
			t.Fatal(done, err)
		}
		duplicate, err := jobs.Start(ctx, api.Job{Session: id, Key: "one", Actor: "local-user", Owner: "owner", Kind: "test"}, func(context.Context) api.Outcome { t.Error("duplicate body ran"); return api.Outcome{} })
		if err != nil || duplicate.ID != job.ID {
			t.Fatal(duplicate, err)
		}
		s, _ := a.Snapshot(id)
		if u := api.SessionUsage(s); u.Input != 7 || u.Output != 2 {
			t.Fatal(u)
		}
		starts, ends := 0, 0
		for _, e := range s.Entries {
			if e.Kind == "job.start" {
				starts++
			}
			if e.Kind == "job.end" {
				ends++
			}
		}
		if starts != 1 || ends != 1 {
			t.Fatal(starts, ends)
		}
	})
}
