package subagents_test

import (
	"bufio"
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSubagentSIGKILLRecovery(t *testing.T) {
	if root := os.Getenv("M3_SUBAGENT_ROOT"); root != "" {
		release := make(chan struct{})
		started := make(chan struct{}, 1)
		p := scripts(func(ctx context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			if first(r) == "child task" {
				started <- struct{}{}
				select {
				case <-ctx.Done():
					return api.Response{}, ctx.Err()
				case <-release:
					return text("actual child result"), nil
				}
			}
			if models(r) == 0 {
				return call("delegate", "spawn", map[string]any{"task": "child task", "background": true}), nil
			}
			return text("parent finished"), nil
		})
		options := vanilla.Options{History: filepath.Join(root, "history"), Global: filepath.Join(root, "absent"), Provider: p.Plugin(), Model: "fake"}
		if os.Getenv("M3_RUNTIME") == "durable" {
			options.Runtime = durable.Plugin()
		}
		h, err := vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		if os.Getenv("M3_JOB_CUT") == "ended" {
			err := h.Load(api.Plugin{Name: "job-crash-barrier", Setup: func(a api.API) error {
				return a.Handle("turn.prepare", "first", func(ctx context.Context, _ any) (api.Decision, error) {
					if strings.HasPrefix(api.Acting(ctx), "job:") {
						// The atomic end already admitted the report. Hold the ready turn
						// before it can consume the receipt, independent of the event callback.
						<-ctx.Done()
					}
					return api.Decision{}, nil
				})
			}})
			if err != nil {
				t.Fatal(err)
			}
		}
		id, err := h.API().New(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		ready := func() {
			if _, err := fmt.Fprintln(os.Stdout, "crash-ready:"+id); err != nil {
				t.Error(err)
			}
		}
		if os.Getenv("M3_JOB_CUT") == "ended" {
			h.API().Subscribe(func(e api.Event) {
				if e.Kind == "history.added" && api.Decode[api.Entry](e.Data).Kind == "job.end" {
					ready()
					for {
						time.Sleep(time.Hour)
					}
				}
			})
		}
		if _, err := h.API().Submit(t.Context(), id, api.Input{Content: api.Text("parent task")}); err != nil {
			t.Fatal(err)
		}
		if out, err := h.API().Wait(t.Context(), id); err != nil || out.Status != "completed" {
			t.Fatal(out, err)
		}
		<-started
		if os.Getenv("M3_JOB_CUT") == "ended" {
			close(release)
		} else {
			ready()
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	runtimetest.Each(t, func(t *testing.T) {
		for _, kind := range []string{"transient-child", "durable-child"} {
			t.Run(kind, func(t *testing.T) {
				for _, cut := range []string{"unfinished", "ended"} {
					t.Run(cut, func(t *testing.T) {
						root := t.TempDir()
						ctx := t.Context()
						cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSubagentSIGKILLRecovery$")
						cmd.Env = append(os.Environ(), "M3_SUBAGENT_ROOT="+root, "M3_JOB_CUT="+cut, "M3_RUNTIME="+runtimetest.Plugin(t).Name)
						stdout, err := cmd.StdoutPipe()
						if err != nil {
							t.Fatal(err)
						}
						cmd.Stderr = os.Stderr
						if err := cmd.Start(); err != nil {
							t.Fatal(err)
						}
						t.Cleanup(func() {
							if cmd.ProcessState == nil {
								_ = cmd.Process.Kill()
								_ = cmd.Wait()
							}
						})
						line, err := bufio.NewReader(stdout).ReadString('\n')
						id, ok := strings.CutPrefix(strings.TrimSpace(line), "crash-ready:")
						if err != nil || !ok || id == "" {
							t.Fatalf("helper did not reach crash boundary: %q, %v", line, err)
						}
						if err := cmd.Process.Kill(); err != nil {
							t.Fatal(err)
						}
						_ = cmd.Wait()
						p := scripts(func(_ context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
							if first(r) == "child task" {
								return text("actual child result"), nil
							}
							if strings.Contains(string(api.JSON(r)), "outcome unknown") {
								return text("parent saw unknown outcome"), nil
							}
							return text("parent saw actual child result"), nil
						})
						options := vanilla.Options{History: filepath.Join(root, "history"), Global: filepath.Join(root, "absent"), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake", DurableSubagents: kind == "durable-child"}
						h, err := vanilla.New(options)
						if err != nil {
							t.Fatal(err)
						}
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
						done, err := jobs.Wait(ctx, id, list[0].ID)
						if err != nil {
							t.Fatal(err)
						}
						out, err := a.Wait(ctx, id)
						if err != nil {
							t.Fatal(err)
						}
						if kind == "transient-child" && cut == "unfinished" {
							if done.State != "failed" || !strings.Contains(out.Result.Text(), "unknown") {
								t.Fatal(done, out)
							}
						} else {
							if done.State != "completed" || !strings.Contains(out.Result.Text(), "actual child result") {
								t.Fatal(done, out)
							}
						}
						s, _ := a.Snapshot(id)
						starts, ends, reports := 0, 0, 0
						for _, e := range s.Entries {
							if e.Kind == "job.start" {
								starts++
							}
							if e.Kind == "job.end" {
								ends++
							}
							if e.Kind == "input" && e.Job == done.ID {
								reports++
								if e.Content.Text() != done.Outcome.Result.Text() {
									t.Fatalf("job report %q differs from result %q", e.Content.Text(), done.Outcome.Result.Text())
								}
							}
						}
						if starts != 1 || ends != 1 || reports != 1 {
							t.Fatal(starts, ends, reports)
						}
						requests := len(p.Requests())
						if err = h.Close(); err != nil {
							t.Fatal(err)
						}
						h, err = vanilla.New(options)
						if err != nil {
							t.Fatal(err)
						}
						defer h.Close()
						if err = h.API().Open(context.Background(), id); err != nil {
							t.Fatal(err)
						}
						if _, err := h.API().Wait(ctx, id); err != nil {
							t.Fatal(err)
						}
						if len(p.Requests()) != requests {
							t.Fatal("report was delivered twice")
						}
					})
				}
			})
		}
	})
}
