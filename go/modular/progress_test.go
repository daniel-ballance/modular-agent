package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestServedJobProgressThroughOwnOutputGate(t *testing.T) {
	for _, transport := range []string{"stdio", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			a := newCallbackTestAgent(t, ctx, serveProgressPlugin(t, ctx, transport))
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			ready, progress := make(chan struct{}), make(chan modular.JobProgressData, 2)
			toolProgress := make(chan modular.ToolOutputData, 1)
			go func() {
				defer close(progress)
				first := true
				for e, err := range s.Events(ctx) {
					if first {
						close(ready)
						first = false
					}
					if err != nil {
						return
					}
					switch e := e.(type) {
					case modular.TypedEvent[modular.JobProgressData]:
						select {
						case progress <- e.Data:
						case <-ctx.Done():
							return
						}
					case modular.TypedEvent[modular.ToolOutputData]:
						select {
						case toolProgress <- e.Data:
						case <-ctx.Done():
							return
						}
					}
				}
			}()
			takeInterruptionCheck(t, ctx, ready, "events follower")
			call := make(chan error, 1)
			go func() {
				got, err := s.CallTool(ctx, "preview", struct{}{})
				if err == nil && got.Text() != "done" {
					err = fmt.Errorf("call: %+v", got)
				}
				call <- err
			}()
			var jobID string
			for _, text := range []string{"first", "second"} {
				got := takeInterruptionCheck(t, ctx, progress, "gated job progress")
				if got.JobID == "" || jobID != "" && got.JobID != jobID || got.Content.Text() != "gated "+text ||
					len(got.Content) != 3 || !reflect.DeepEqual(got.Content[1:], previewContent(text)) {
					t.Fatalf("job progress: %+v", got)
				}
				jobID = got.JobID
			}
			if err := takeInterruptionCheck(t, ctx, call, "preview call"); err != nil {
				t.Fatal(err)
			}
			if got := takeInterruptionCheck(t, ctx, toolProgress, "held tool progress"); got.Chunk != "gated tool" ||
				!reflect.DeepEqual(got.Content, previewContent("gated tool")) {
				t.Fatalf("tool progress: %+v", got)
			}
		})
	}
}

func previewContent(text string) modular.Content {
	var content modular.Content
	if err := json.Unmarshal([]byte(fmt.Sprintf(`[{"type":"text","text":%q},{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}]`, text)), &content); err != nil {
		panic(err)
	}
	return content
}

func progressPlugin() modular.Plugin {
	return modular.Plugin{Name: "preview", Setup: func(r *modular.Registrar) error {
		return errors.Join(
			r.Tool(modular.NewTool("preview", "Report tool and job progress with images", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
				if err := tc.Progress(previewContent("tool")); err != nil {
					return "", err
				}
				job, err := tc.Jobs.Start(ctx, "preview", nil)
				if err != nil {
					return "", err
				}
				for _, text := range []string{"first", "second"} {
					if err := job.Progress(ctx, previewContent(text)); err != nil {
						return "", err
					}
				}
				return "done", job.End(ctx, modular.Outcome{Kind: "completed"}, nil, false)
			})),
			r.Jobs(modular.JobOwner{Cancel: func(context.Context, *modular.Job) error { return nil }}),
			r.OnOutput(func(_ context.Context, batch modular.OutputBatch) (modular.OutputDecision, error) {
				for i, event := range batch.Events {
					if event.Type == "toolOutput" {
						var data modular.ToolOutputData
						if err := json.Unmarshal(event.Data, &data); err != nil || data.Chunk != "tool" ||
							!reflect.DeepEqual(data.Content, previewContent("tool")) {
							return modular.OutputDecision{}, fmt.Errorf("wrong tool progress in gate: %s", event.Data)
						}
						data.Chunk, data.Content = "gated tool", previewContent("gated tool")
						batch.Events[i].Data, _ = json.Marshal(data)
					}
					if event.Type != "job.progress" {
						continue
					}
					var data struct {
						JobID   string            `json:"jobId"`
						Content []json.RawMessage `json:"content"`
					}
					if err := json.Unmarshal(event.Data, &data); err != nil || data.JobID == "" || len(data.Content) != 2 {
						return modular.OutputDecision{}, fmt.Errorf("wrong job progress in gate: %s", event.Data)
					}
					data.Content = append([]json.RawMessage{json.RawMessage(`{"type":"text","text":"gated "}`)}, data.Content...)
					replacement, err := json.Marshal(data)
					if err != nil {
						return modular.OutputDecision{}, err
					}
					batch.Events[i].Data = replacement
				}
				return modular.OutputDecision{Events: &batch.Events}, nil
			}),
		)
	}}
}

func serveProgressPlugin(t *testing.T, ctx context.Context, transport string) modular.Option {
	t.Helper()
	if transport == "stdio" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		return modular.WithProcessPlugin(modular.ProcessPlugin{
			Command: []string{exe, "-test.run=^TestProgressPluginProgram$"},
			Env:     map[string]string{"MA_TEST_PROGRESS_PLUGIN": "1"},
		})
	}
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("test-6459e00a5698d09fd13114a767d0e94f"), 0600); err != nil {
		t.Fatal(err)
	}
	svc, err := modular.ServeService(ctx, progressPlugin(), modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: tokenFile})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	return modular.WithServicePlugin(modular.ServicePlugin{URL: svc.URL, TokenFile: tokenFile})
}

func TestProgressPluginProgram(t *testing.T) {
	if os.Getenv("MA_TEST_PROGRESS_PLUGIN") != "1" {
		t.Skip("only run in the plugin child")
	}
	if err := modular.Serve(t.Context(), progressPlugin()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

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
