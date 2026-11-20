package subagents_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/credentials"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newAgent(t *testing.T, p *fake.Provider, depth int) (*harness.Harness, string, api.Jobs) {
	t.Helper()
	h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake", MaxSubagentDepth: depth})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Load(credentials.Plugin(filepath.Join(t.TempDir(), "key"))); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	id, err := h.API().New(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	v, _ := h.API().Get("jobs")
	return h, id, v.(api.Jobs)
}
func scripts(run func(context.Context, api.Request, func(api.Part)) (api.Response, error)) *fake.Provider {
	var ss []fake.Script
	for range 30 {
		ss = append(ss, fake.Script{Run: run})
	}
	return fake.New(ss...)
}
func text(s string) api.Response {
	return api.Response{Content: api.Text(s), Stop: "finished", Usage: api.Usage{Input: 3, Output: 2}}
}
func call(name, id string, input any) api.Response {
	return api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{Name: name, ID: id, Input: api.JSON(input)}}}, Stop: "tools"}
}
func first(r api.Request) string {
	for _, m := range r.Messages {
		if m.Role == "user" {
			return m.Content.Text()
		}
	}
	return ""
}
func models(r api.Request) int {
	n := 0
	for _, m := range r.Messages {
		if m.Role == "assistant" {
			n++
		}
	}
	return n
}
func wait(t *testing.T, a api.API, id string) api.Outcome {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	o, err := a.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return o
}
func waitJob(t *testing.T, j api.Jobs, id, job string) api.Job {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := j.Wait(ctx, id, job)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestBackgroundReportStartsParentTurnAndChildGetsOnlyTask(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		release := make(chan struct{})
		var once sync.Once
		p := scripts(func(ctx context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			if first(r) == "child-only task" {
				if strings.Contains(string(api.JSON(r)), "PARENT-ONLY") {
					t.Error("parent history leaked")
				}
				select {
				case <-ctx.Done():
					return api.Response{}, ctx.Err()
				case <-release:
				}
				if models(r) == 0 {
					return call("bash", "child-bash", map[string]string{"command": "printf 'child marker' > child.txt"}), nil
				}
				return text("I wrote child.txt with bash"), nil
			}
			if models(r) == 0 {
				return call("delegate", "spawn", map[string]any{"task": "child-only task", "background": true}), nil
			}
			if r.Messages[len(r.Messages)-1].Content.Text() == "I wrote child.txt with bash" {
				return text("The child wrote child.txt with bash"), nil
			}
			return text("parent turn finished"), nil
		})
		h, id, jobs := newAgent(t, p, 3)
		a := h.API()
		_, _ = a.Submit(context.Background(), id, api.Input{Content: api.Text("PARENT-ONLY")})
		out := wait(t, a, id)
		if out.Result.Text() != "parent turn finished" {
			t.Fatal(out)
		}
		list, _ := jobs.List(id)
		if len(list) != 1 || list[0].State != "running" {
			t.Fatal(list)
		}
		once.Do(func() { close(release) })
		done := waitJob(t, jobs, id, list[0].ID)
		if done.State != "completed" || done.Outcome.Usage.Input != 3 {
			t.Fatal(done)
		}
		out = wait(t, a, id)
		if !strings.Contains(out.Result.Text(), "child wrote") {
			t.Fatal(out)
		}
		s, _ := a.Snapshot(id)
		b, err := os.ReadFile(filepath.Join(s.Project, "child.txt"))
		if err != nil || string(b) != "child marker" {
			t.Fatal(string(b), err)
		}
		turns, starts, ends, reports := 0, 0, 0, 0
		for _, e := range s.Entries {
			switch e.Kind {
			case "turn.start":
				turns++
			case "job.start":
				starts++
			case "job.end":
				ends++
			case "input":
				if e.Job == done.ID {
					reports++
				}
			}
		}
		if turns != 2 || starts != 1 || ends != 1 || reports != 1 {
			t.Fatal(turns, starts, ends, reports)
		}
		if usage := api.SessionUsage(s); usage.Input != 9 {
			t.Fatal("job usage missing or report counted twice", usage)
		}
	})
}
func TestWaitedChildFollowupRemembersAndDoesNotReportTwice(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		p := scripts(func(_ context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			if strings.Contains(string(api.JSON(r)), "remember cobalt") {
				if strings.Contains(string(api.JSON(r)), "recall") {
					return text("cobalt remembered"), nil
				}
				return text("cobalt saved"), nil
			}
			return text("unexpected"), nil
		})
		h, id, jobs := newAgent(t, p, 3)
		a := h.API()
		ctx := context.Background()
		r, err := a.CallTool(ctx, id, api.Call{Name: "delegate", Input: api.JSON(map[string]any{"task": "remember cobalt", "background": false})})
		if err != nil || !strings.Contains(r.Content.Text(), "cobalt saved") {
			t.Fatal(r, err)
		}
		list, _ := jobs.List(id)
		d := api.Decode[struct{ Child string }](list[0].Detail)
		child, _ := a.Snapshot(d.Child)
		if child.Parent != id || child.Depth != 1 || child.Actor != "parent-agent" {
			t.Fatal(child)
		}
		r, err = a.CallTool(ctx, id, api.Call{Name: "delegate", Input: api.JSON(map[string]any{"task": "recall", "session": d.Child, "background": false})})
		if err != nil || !strings.Contains(r.Content.Text(), "cobalt remembered") {
			t.Fatal(r, err)
		}
		list, _ = jobs.List(id)
		if len(list) != 2 {
			t.Fatal(list)
		}
		s, _ := a.Snapshot(id)
		for _, e := range s.Entries {
			if e.Kind == "input" {
				t.Fatal("waited job sent duplicate report")
			}
		}
		child, _ = a.Snapshot(d.Child)
		turns := 0
		for _, e := range child.Entries {
			if e.Kind == "turn.start" {
				turns++
			}
		}
		if turns != 2 {
			t.Fatal(turns)
		}
	})
}
func TestNestedQuestionsReachTopUserAndDepthLimit(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		p := scripts(func(_ context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			switch first(r) {
			case "level one":
				if models(r) == 0 {
					return call("delegate", "grandchild", map[string]any{"task": "level two", "background": false}), nil
				}
				return text("level one got cobalt"), nil
			case "level two":
				if models(r) == 0 {
					return call("ask_user", "nested-question", map[string]any{"question": "Which color?", "kind": "choice", "options": []string{"cobalt", "red"}}), nil
				}
				return text("level two got cobalt"), nil
			default:
				return text("unexpected"), nil
			}
		})
		h, id, _ := newAgent(t, p, 2)
		a := h.API()
		v, _ := a.Get("questions")
		q := v.(api.Questions)
		ctx := context.Background()
		seen := make(chan api.Question, 1)
		a.Subscribe(func(e api.Event) {
			if e.Kind == "question.open" && e.Session == id {
				question := api.Decode[api.Question](e.Data)
				if len(question.Path) != 2 {
					t.Errorf("forwarding path %v", question.Path)
				}
				if err := q.Answer(ctx, id, api.Answer{Request: question.ID, Value: "cobalt"}); err != nil {
					t.Error(err)
				}
				seen <- question
			}
		})
		r, err := a.CallTool(ctx, id, api.Call{Name: "delegate", Input: api.JSON(map[string]any{"task": "level one", "background": false})})
		if err != nil || !strings.Contains(r.Content.Text(), "got cobalt") {
			t.Fatal(r, err)
		}
		select {
		case <-seen:
		default:
			t.Fatal("no top question")
		}
		all, _ := a.List("")
		var deepest api.Session
		questions := 0
		for _, s := range all {
			if s.Depth == 2 {
				deepest = s
			}
			for _, e := range s.Entries {
				if e.Kind == "question.answer" {
					questions++
				}
			}
		}
		if questions != 3 {
			t.Fatal("answer not recorded at every level", questions)
		}
		r, err = a.CallTool(api.AsActor(ctx, deepest.Actor), deepest.ID, api.Call{Name: "delegate", Input: api.JSON(map[string]any{"task": "too deep", "background": false})})
		if err != nil || !strings.Contains(r.Content.Text(), "depth limit") {
			t.Fatal(r, err)
		}
	})
}
func TestChildCannotWidenAuthorityAndParentRevocationApplies(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		p := scripts(func(_ context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			return text("done"), nil
		})
		h, id, jobs := newAgent(t, p, 3)
		a := h.API()
		ctx := context.Background()
		rights := []string{"watch", "input", "tools", "jobs", "delegate", "answer"}
		if err := a.Grant(ctx, id, api.Actor{ID: "limited", Kind: "agent", Rights: rights}); err != nil {
			t.Fatal(err)
		}
		_, err := a.CallTool(api.AsActor(ctx, "limited"), id, api.Call{Name: "delegate", Input: api.JSON(map[string]any{"task": "limited task", "background": false})})
		if err != nil {
			t.Fatal(err)
		}
		list, _ := jobs.List(id)
		d := api.Decode[struct{ Child string }](list[0].Detail)
		child, _ := a.Snapshot(d.Child)
		if a.Authorize(child.ID, child.Actor, "approve") || a.Authorize(child.ID, child.Actor, "grant") {
			t.Fatal("child widened authority")
		}
		if err := a.Grant(ctx, id, api.Actor{ID: "limited", Rights: []string{"watch"}}); err != nil {
			t.Fatal(err)
		}
		r, err := a.CallTool(api.AsActor(ctx, child.Actor), child.ID, api.Call{Name: "write", Input: api.JSON(map[string]string{"path": "bad", "content": "bad"})})
		if err != nil || r.Status != "refused" {
			t.Fatal(r, err)
		}
	})
}
func TestTurnCancelLeavesJobsButJobCancelAndSessionCloseStopThem(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		p := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			<-ctx.Done()
			return api.Response{}, ctx.Err()
		}})
		h, id, j := newAgent(t, p, 3)
		a := h.API()
		ctx := context.Background()
		start := make(chan struct{})
		ended := make(chan struct{})
		job, err := j.Start(ctx, api.Job{Session: id, Actor: "local-user", Owner: "test", Kind: "watcher"}, func(ctx context.Context) api.Outcome {
			close(start)
			<-ctx.Done()
			close(ended)
			return api.Outcome{Status: "cancelled"}
		})
		if err != nil {
			t.Fatal(err)
		}
		<-start
		_, _ = a.Submit(ctx, id, api.Input{Content: api.Text("wait")})
		_ = a.Cancel(id)
		_ = wait(t, a, id)
		select {
		case <-ended:
			t.Fatal("turn cancelled job")
		default:
		}
		if err = j.Cancel(ctx, id, job.ID); err != nil {
			t.Fatal(err)
		}
		done := waitJob(t, j, id, job.ID)
		if done.State != "cancelled" {
			t.Fatal(done)
		}
		job, err = j.Start(ctx, api.Job{Session: id, Actor: "local-user", Owner: "test", Kind: "watcher"}, func(ctx context.Context) api.Outcome { <-ctx.Done(); return api.Outcome{Status: "cancelled"} })
		if err != nil {
			t.Fatal(err)
		}
		if err = a.CloseSession(id); err != nil {
			t.Fatal(err)
		}
		stored, _ := a.List("")
		found := false
		for _, s := range stored {
			for _, e := range s.Entries {
				if e.Kind == "job.end" && e.Job == job.ID {
					found = api.Decode[api.Job](e.Data).State == "cancelled"
				}
			}
		}
		if !found {
			t.Fatal("close did not end job")
		}
	})
}
