package subagents_test

import (
	"context"
	"modular/api"
	"modular/internal/runtimetest"
	"modular/vanilla"
	"path/filepath"
	"testing"
	"time"
)

func TestDurableSubagentSurvivesRepeatedOrderlyProcessStops(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		id := ""
		options := vanilla.Options{History: filepath.Join(root, "history"), Runtime: runtimetest.Plugin(t), Model: "fake", DurableSubagents: true}
		for round := 0; round < 2; round++ {
			started := make(chan struct{})
			p := scripts(func(ctx context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
				if first(r) == "child task" {
					close(started)
					<-ctx.Done()
					return api.Response{}, ctx.Err()
				}
				if models(r) == 0 {
					return call("delegate", "spawn", map[string]any{"task": "child task", "background": true}), nil
				}
				return text("parent finished"), nil
			})
			options.Provider = p.Plugin()
			h, err := vanilla.New(options)
			if err != nil {
				t.Fatal(err)
			}
			a := h.API()
			if round == 0 {
				id, err = a.New(context.Background(), root)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = a.Submit(context.Background(), id, api.Input{Content: api.Text("parent task")})
				_ = wait(t, a, id)
			} else if err = a.Open(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("child did not resume")
			}
			if err = h.Close(); err != nil {
				t.Fatal(err)
			}
		}
		p := scripts(func(_ context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			if first(r) == "child task" {
				return text("real child result"), nil
			}
			return text("parent got real child result"), nil
		})
		options.Provider = p.Plugin()
		h, err := vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a := h.API()
		if err = a.Open(context.Background(), id); err != nil {
			t.Fatal(err)
		}
		v, _ := a.Get("jobs")
		jobs := v.(api.Jobs)
		list, _ := jobs.List(id)
		if len(list) != 1 {
			t.Fatal(list)
		}
		job := waitJob(t, jobs, id, list[0].ID)
		out := wait(t, a, id)
		if job.State != "completed" || out.Result.Text() != "parent got real child result" {
			t.Fatal(job, out)
		}
	})
}
