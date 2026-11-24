package questions_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestQuestionSIGKILLReplay(t *testing.T) {
	if root := os.Getenv("M3_QUESTION_ROOT"); root != "" {
		p := fake.New(response(api.Call{ID: "ask", Name: "ask_user", Input: api.JSON(map[string]string{"question": "Which?"})}), final("done"))
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Runtime: durable.Plugin(), Provider: p.Plugin(), Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		id, err := h.API().New(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		runtimetest.Publish(t, h.API(), id)
		_ = os.WriteFile(filepath.Join(root, "session"), []byte(id), 0600)
		v, _ := h.API().Get("questions")
		q := v.(api.Questions)
		h.API().Subscribe(func(e api.Event) {
			if e.Kind == "question.open" && os.Getenv("M3_QUESTION_CUT") == "answered" {
				question := api.Decode[api.Question](e.Data)
				if err := q.Answer(context.Background(), id, api.Answer{Request: question.ID, Value: "cobalt"}); err != nil {
					panic(err)
				}
			}
			if e.Kind == "question.open" && os.Getenv("M3_QUESTION_CUT") == "open" || e.Kind == "question.answered" && os.Getenv("M3_QUESTION_CUT") == "answered" {
				_ = os.WriteFile(filepath.Join(root, "ready"), []byte("yes"), 0600)
				for {
					time.Sleep(time.Hour)
				}
			}
		})
		_, _ = h.API().Submit(context.Background(), id, api.Input{Content: api.Text("go")})
		_, _ = h.API().Wait(context.Background(), id)
		t.Fatal("did not reach question boundary")
	}
	runtimetest.Each(t, func(t *testing.T) {
		for _, cut := range []string{"open", "answered"} {
			t.Run(cut, func(t *testing.T) {
				root := t.TempDir()
				cmd := exec.Command(os.Args[0], "-test.run=^TestQuestionSIGKILLReplay$")
				cmd.Env = append(os.Environ(), "M3_QUESTION_ROOT="+root, "M3_QUESTION_CUT="+cut)
				if err := cmd.Start(); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if cmd.ProcessState == nil {
						_ = cmd.Process.Kill()
						_ = cmd.Wait()
					}
				})
				deadline := time.Now().Add(5 * time.Second)
				for {
					if _, err := os.Stat(filepath.Join(root, "ready")); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("helper never reached question")
					}
					time.Sleep(time.Millisecond * 5)
				}
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				b, _ := os.ReadFile(filepath.Join(root, "session"))
				id := string(b)
				p := fake.New(fake.Script{Response: api.Response{Content: api.Text("continued"), Stop: "finished"}})
				h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake"})
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				a := h.API()
				isDurable := runtimetest.Plugin(t).Name == "durable"
				canRepeat := isDurable && runtimetest.StopsOnCrash(t, a)
				wantStatus, wantContext, wantAsked := "unknown", "outcome is unknown", 0
				if canRepeat {
					wantStatus, wantContext = "completed", "cobalt"
					if cut == "open" {
						wantAsked = 1
					}
				}
				v, _ := a.Get("questions")
				q := v.(api.Questions)
				asked := 0
				a.Subscribe(func(e api.Event) {
					if e.Kind == "question.open" {
						asked++
						question := api.Decode[api.Question](e.Data)
						if err := q.Answer(context.Background(), id, api.Answer{Request: question.ID, Value: "cobalt"}); err != nil {
							t.Error(err)
						}
					}
				})
				if err = a.Open(context.Background(), id); err != nil {
					t.Fatal(err)
				}
				out := wait(t, a, id)
				if asked != wantAsked {
					t.Fatalf("opened %d questions after restart, want %d", asked, wantAsked)
				}
				requests := p.Requests()
				checkResult := func(r api.ToolResult) {
					t.Helper()
					if r.Call != "ask" || r.Status != wantStatus || !strings.Contains(r.Content.Text(), wantContext) {
						t.Fatal(r, wantStatus, wantContext)
					}
				}
				if isDurable {
					if out.Status != "completed" || out.Result.Text() != "continued" || len(requests) != 1 {
						t.Fatal(out, requests)
					}
					results := 0
					for _, msg := range requests[0].Messages {
						if msg.Result != nil {
							checkResult(*msg.Result)
							results++
						}
					}
					if results != 1 {
						t.Fatalf("model saw %d tool results, want one", results)
					}
				} else if out.Status != "failed" || len(requests) != 0 {
					t.Fatal(out, requests)
				}
				if !canRepeat {
					list, err := q.List(id)
					if err != nil {
						t.Fatal(err)
					}
					for _, question := range list {
						if question.Answerable {
							t.Fatal("lost question still answerable")
						}
					}
				}
				s, _ := a.Snapshot(id)
				results := 0
				for _, e := range s.Entries {
					if e.Kind == "tool.result" {
						results++
						checkResult(api.Decode[api.ToolResult](e.Data))
					}
				}
				if results != 1 {
					t.Fatal(results)
				}
			})
		}
	})
}
func TestReplayedAllowFromRevokedActorIsNotUsed(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		ctx := context.Background()
		options := vanilla.Options{History: filepath.Join(root, "history"), Runtime: runtimetest.Plugin(t), Provider: fake.New().Plugin(), Model: "fake"}
		h, err := vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		a := h.API()
		id, err := a.New(ctx, root)
		if err != nil {
			t.Fatal(err)
		}
		runtimetest.Publish(t, a, id)
		v, _ := a.Get("questions")
		q := v.(api.Questions)
		disconnect := q.Connect(id, "local-user")
		request := api.Question{Session: id, Key: "persisted-approval", Kind: "approval", Prompt: "Run?", Wait: time.Millisecond, Defer: true}
		_, _ = q.Ask(ctx, request)
		list, _ := q.List(id)
		if err = q.Answer(ctx, id, api.Answer{Request: list[0].ID, Value: "allow"}); err != nil {
			t.Fatal(err)
		}
		disconnect()
		if err = h.Close(); err != nil {
			t.Fatal(err)
		}
		h, err = vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a = h.API()
		if err = a.Open(ctx, id); err != nil {
			t.Fatal(err)
		}
		v, _ = a.Get("questions")
		q = v.(api.Questions)
		var rights []string
		for _, r := range api.Rights {
			if r != "approve" {
				rights = append(rights, r)
			}
		}
		if err = a.Grant(ctx, id, api.Actor{ID: "local-user", Rights: rights}); err != nil {
			t.Fatal(err)
		}
		if answer, e := q.Ask(ctx, request); e == nil && answer.Value == "allow" {
			t.Fatal("revoked persisted allow reused")
		}
	})
}
