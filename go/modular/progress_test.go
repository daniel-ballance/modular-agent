package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestImageProgressReachesEventsFollowers(t *testing.T) {
	const reported = `[{"type":"text","text":"preview"},{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}]`
	for _, place := range []string{"inProcess", "served"} {
		t.Run(place, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var content modular.Content
			if err := json.Unmarshal([]byte(reported), &content); err != nil {
				t.Fatal(err)
			}
			tool := modular.NewTool("preview", "Report a preview", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
				if err := tc.Progress(content); err != nil {
					return "", err
				}
				job, err := tc.Jobs.Start(ctx, "preview", nil)
				if err != nil {
					return "", err
				}
				return "done", errors.Join(job.Progress(ctx, content), job.End(ctx, modular.Outcome{Kind: "completed"}, nil, false))
			})
			plugin := modular.Plugin{Name: "preview", Setup: func(r *modular.Registrar) error {
				return errors.Join(r.Tool(tool), r.Jobs(modular.JobOwner{Cancel: func(context.Context, *modular.Job) error { return nil }}))
			}}
			observer := modular.Plugin{Name: "observer", Setup: func(r *modular.Registrar) error {
				return r.OnOutput(func(_ context.Context, batch modular.OutputBatch) (modular.OutputDecision, error) {
					// Exercise both the binding projection and the follower projection.
					for _, event := range batch.Events {
						if event.Type != "toolOutput" {
							continue
						}
						var output modular.ToolOutputData
						if err := json.Unmarshal(event.Data, &output); err != nil || output.Chunk != "preview" || !reflect.DeepEqual(output.Content, content) {
							return modular.OutputDecision{}, fmt.Errorf("wrong toolOutput payload: %s", event.Data)
						}
					}
					return modular.OutputDecision{}, nil
				})
			}}
			opt := modular.WithPlugin(plugin)
			if place == "served" {
				opt = modulartest.OverWire(plugin)
			}
			a := modulartest.Agent(t, opt, modular.WithPlugin(observer))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			ready, checked := make(chan struct{}), make(chan error, 1)
			go func() {
				seenTool, seenJob := false, false
				first := true
				for e, err := range s.Events(ctx) {
					if first {
						close(ready)
						first = false
					}
					if err != nil {
						checked <- err
						return
					}
					switch e := e.(type) {
					case modular.TypedEvent[modular.ToolOutputData]:
						if e.Data.ToolCallID == "" || e.Data.ToolCallID != e.CallID || e.Data.Chunk != "preview" || !reflect.DeepEqual(e.Data.Content, content) {
							checked <- fmt.Errorf("wrong tool progress: %s", e.Raw().Data)
							return
						}
						seenTool = true
					case modular.TypedEvent[modular.JobProgressData]:
						if e.Data.JobID == "" || !reflect.DeepEqual(e.Data.Content, content) {
							checked <- fmt.Errorf("wrong job progress: %s", e.Raw().Data)
							return
						}
						seenJob = true
					}
					if seenTool && seenJob {
						checked <- nil
						return
					}
				}
			}()
			takeInterruptionCheck(t, ctx, ready, "events follower")
			if got, err := s.CallTool(ctx, "preview", struct{}{}); err != nil || got.Text() != "done" {
				t.Fatalf("call: %+v %v", got, err)
			}
			if err := takeInterruptionCheck(t, ctx, checked, "tool and job progress"); err != nil {
				t.Fatal(err)
			}
		})
	}
}
