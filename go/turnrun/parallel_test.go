package turnrun_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/vanilla"
	"slices"
	"sync"
	"testing"
	"time"
)

type parallelTools struct {
	parallel          bool
	started, finished chan string
	release           map[string]chan struct{}
}

func (s *parallelTools) Tools(api.Session) []api.Tool {
	return []api.Tool{{Name: "one", Parallel: true, Input: api.JSON(map[string]string{"type": "object"})}, {Name: "two", Parallel: s.parallel, Input: api.JSON(map[string]string{"type": "object"})}}
}
func (s *parallelTools) Run(ctx context.Context, _ api.Session, c api.Call, _ func(string)) api.ToolResult {
	s.started <- c.Name
	select {
	case <-s.release[c.Name]:
	case <-ctx.Done():
	}
	s.finished <- c.Name
	return api.ToolResult{Status: "completed", Content: api.Text(c.Name)}
}
func TestParallelBatchesCommitAsReadyAndReachModelInRequestOrder(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, parallel := range []bool{true, false} {
			name := "all-parallel"
			if !parallel {
				name = "mixed-sequential"
			}
			t.Run(name, func(t *testing.T) {
				s := &parallelTools{parallel: parallel, started: make(chan string, 2), finished: make(chan string, 2), release: map[string]chan struct{}{"one": make(chan struct{}), "two": make(chan struct{})}}
				response := api.Response{Stop: "tools"}
				for _, name := range []string{"one", "two"} {
					response.Content = append(response.Content, api.Part{Type: "tool_call", Call: &api.Call{ID: name, Name: name, Input: api.JSON(map[string]string{})}})
				}
				p := fake.New(fake.Script{Response: response}, fake.Script{Response: api.Response{Content: api.Text("done"), Stop: "finished"}})
				opt := fakeOptions(t.TempDir(), p, false)
				opt.Runtime = runtimetest.Plugin(t)
				h, err := vanilla.New(opt)
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				var mu sync.Mutex
				var before, after []string
				if err = h.Load(api.Plugin{Name: "parallel-source", Setup: func(a api.API) error {
					if err := a.Handle("runtime.tool.before", "", func(_ context.Context, v any) (api.Decision, error) {
						mu.Lock()
						before = append(before, v.(api.ToolCheck).Call.Name)
						mu.Unlock()
						return api.Decision{Value: v}, nil
					}); err != nil {
						return err
					}
					if err := a.Handle("runtime.tool.after", "", func(_ context.Context, v any) (api.Decision, error) {
						mu.Lock()
						after = append(after, v.(api.AfterTool).Call.Name)
						mu.Unlock()
						return api.Decision{Value: v}, nil
					}); err != nil {
						return err
					}
					return a.Provide("tools.parallel", s)
				}}); err != nil {
					t.Fatal(err)
				}
				id, err := h.API().New(context.Background(), t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				_, err = h.API().Submit(context.Background(), id, api.Input{Content: api.Text("go")})
				if err != nil {
					t.Fatal(err)
				}
				receive := func(ch <-chan string) string {
					t.Helper()
					select {
					case name := <-ch:
						return name
					case <-time.After(3 * time.Second):
						t.Fatal("calls did not overlap")
						return ""
					}
				}
				wantHistory := []string{"one", "two"}
				if parallel {
					wantHistory = []string{"two", "one"}
					results := make(chan string, 2)
					defer h.API().Subscribe(func(e api.Event) {
						if e.Kind == "tool.end" {
							results <- e.Call
						}
					})()
					a, b := receive(s.started), receive(s.started)
					if a == b {
						t.Fatal(a, b)
					}
					// Release the first call only after the second result is committed.
					close(s.release["two"])
					got := receive(results)
					close(s.release["one"])
					if got != "two" {
						t.Fatal("wrong result order", got)
					}
				} else {
					if receive(s.started) != "one" {
						t.Fatal("mixed batch overlapped")
					}
					select {
					case <-s.started:
						t.Fatal("second body started too early")
					default:
					}
					close(s.release["one"])
					if receive(s.started) != "two" {
						t.Fatal("wrong execution order")
					}
					close(s.release["two"])
				}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				out, err := h.API().Wait(ctx, id)
				if err != nil || out.Status != "completed" {
					t.Fatal(out, err)
				}
				snap, _ := h.API().Snapshot(id)
				var order []string
				for _, e := range snap.Entries {
					if e.Kind == "tool.result" {
						order = append(order, e.Call)
					}
				}
				if !slices.Equal(order, wantHistory) {
					t.Fatal(order)
				}
				var modelOrder []string
				for _, message := range p.Requests()[1].Messages {
					if message.Result != nil {
						modelOrder = append(modelOrder, message.Result.Call)
					}
				}
				if !slices.Equal(modelOrder, []string{"one", "two"}) {
					t.Fatal(modelOrder)
				}
				mu.Lock()
				defer mu.Unlock()
				if !slices.Equal(before, []string{"one", "two"}) || !slices.Equal(after, wantHistory) {
					t.Fatal(before, after)
				}
			})
		}
	})
}
