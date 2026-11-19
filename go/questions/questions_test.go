package questions_test

import (
	"context"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/credentials"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func setup(t *testing.T, scripts ...fake.Script) (api.API, api.Questions, string, *fake.Provider, *harness.Harness) {
	t.Helper()
	p := fake.New(scripts...)
	root := t.TempDir()
	h, err := vanilla.New(vanilla.Options{Runtime: runtimetest.Plugin(t), History: filepath.Join(root, "history"), Provider: p.Plugin(), Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Load(credentials.Plugin(filepath.Join(root, "key"))); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	id, err := h.API().New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := h.API().Get("questions")
	return h.API(), v.(api.Questions), id, p, h
}
func response(calls ...api.Call) fake.Script {
	var c api.Content
	for _, call := range calls {
		cc := call
		c = append(c, api.Part{Type: "tool_call", Call: &cc})
	}
	return fake.Script{Response: api.Response{Content: c, Stop: "tools"}}
}
func final(text string) fake.Script {
	return fake.Script{Response: api.Response{Content: api.Text(text), Stop: "finished"}}
}
func wait(t *testing.T, a api.API, id string) api.Outcome {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	o, e := a.Wait(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	return o
}
func TestRecordedKindsKeysAuthorityAndSecrets(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, q, id, p, _ := setup(t)
		ctx := context.Background()
		if err := a.Grant(ctx, id, api.Actor{ID: "viewer", Kind: "user", Rights: []string{"watch"}}); err != nil {
			t.Fatal(err)
		}
		if _, err := a.View(api.AsActor(ctx, "viewer"), id); err != nil {
			t.Fatal(err)
		}
		if err := a.Grant(api.AsActor(ctx, "viewer"), id, api.Actor{ID: "intruder", Rights: api.Rights}); err == nil {
			t.Fatal("viewer escalated")
		}
		if err := a.Grant(ctx, id, api.Actor{ID: "limited", Rights: []string{"grant", "watch"}}); err != nil {
			t.Fatal(err)
		}
		if err := a.Grant(api.AsActor(ctx, "limited"), id, api.Actor{ID: "intruder", Rights: []string{"approve"}}); err == nil {
			t.Fatal("grant widened authority")
		}
		for _, kind := range []string{"approval", "choice", "text", "secret"} {
			t.Run(kind, func(t *testing.T) {
				defer q.Connect(id, "local-user")()
				request := api.Question{Session: id, Key: kind, Kind: kind, Prompt: "Which?", Options: []string{"one", "two"}, Credential: "service/token", Wait: time.Millisecond, Defer: true}
				_, err := q.Ask(ctx, request)
				if !errors.Is(err, api.ErrQuestionOpen) {
					t.Fatal(err)
				}
				list, _ := q.List(id)
				var question api.Question
				for _, v := range list {
					if v.Key == kind {
						question = v
					}
				}
				if !question.Answerable {
					t.Fatal(question)
				}
				if err = q.Answer(api.AsActor(ctx, "viewer"), id, api.Answer{Request: question.ID, Value: "allow"}); err == nil {
					t.Fatal("viewer answered")
				}
				value := map[string]string{"approval": "allow", "choice": "two", "text": "free answer", "secret": "sensitive-value-193"}[kind]
				if err = q.Answer(ctx, id, api.Answer{Request: question.ID, Value: value}); err != nil {
					t.Fatal(err)
				}
				if err = q.Answer(ctx, id, api.Answer{Request: question.ID, Value: value}); err == nil {
					t.Fatal("second answer accepted")
				}
				answer, err := q.Ask(ctx, request)
				if kind == "secret" {
					value = request.Credential
				}
				if err != nil || answer.Value != value {
					t.Fatal(answer, err)
				}
			})
		}
		v, _ := a.Get("credentials")
		secret, err := v.(api.Credentials).Get(ctx, "service/token")
		if err != nil || secret != "sensitive-value-193" {
			t.Fatal("credential not stored")
		}
		snap, _ := a.Snapshot(id)
		if strings.Contains(string(api.JSON(snap)), "sensitive-value-193") || len(p.Requests()) != 0 {
			t.Fatal("secret leaked or inference used")
		}
		// A saved allow cannot survive revocation.
		rights := append([]string(nil), api.Rights...)
		var narrowed []string
		for _, r := range rights {
			if r != "approve" {
				narrowed = append(narrowed, r)
			}
		}
		if err = a.Grant(ctx, id, api.Actor{ID: "local-user", Rights: narrowed}); err != nil {
			t.Fatal(err)
		}
		_, err = q.Ask(ctx, api.Question{Session: id, Key: "approval", Kind: "approval", Prompt: "Which?", Options: []string{"one", "two"}, Credential: "service/token", Wait: time.Millisecond, Defer: true})
		if err == nil {
			t.Fatal("stale allow reused")
		}
		list, _ := q.List(id)
		n := 0
		for _, v := range list {
			if v.Key == "approval" {
				n++
			}
		}
		if n != 2 {
			t.Fatal("revoked answer not replaced", n)
		}
	})
}
func TestApprovalPoliciesAndUICallAudit(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, policy := range []string{"off", "ask-unless-read-only", "ask-always", "never"} {
			for _, allow := range []bool{true, false} {
				t.Run(policy+"/"+map[bool]string{true: "allow", false: "refuse"}[allow], func(t *testing.T) {
					a, q, id, p, _ := setup(t)
					ctx := context.Background()
					s, _ := a.Snapshot(id)
					s.Settings.Approval = policy
					if err := a.SetSettings(ctx, id, s.Settings); err != nil {
						t.Fatal(err)
					}
					defer q.Connect(id, "local-user")()
					asked := 0
					a.Subscribe(func(e api.Event) {
						if e.Kind == "question.open" {
							asked++
							v := api.Decode[api.Question](e.Data)
							answer := "refuse"
							if allow {
								answer = "allow"
							}
							if err := q.Answer(ctx, id, api.Answer{Request: v.ID, Value: answer}); err != nil {
								t.Error(err)
							}
						}
					})
					result, err := a.CallTool(ctx, id, api.Call{Name: "write", Input: api.JSON(map[string]string{"path": "out", "content": "ok"})})
					if err != nil {
						t.Fatal(err)
					}
					shouldRun := policy == "off" || policy != "never" && allow
					if (result.Status == "completed") != shouldRun {
						t.Fatal(result)
					}
					if policy == "ask-always" || policy == "ask-unless-read-only" {
						if asked != 1 {
							t.Fatal(asked)
						}
					} else if asked != 0 {
						t.Fatal(asked)
					}
					snap, _ := a.Snapshot(id)
					calls, results := 0, 0
					for _, e := range snap.Entries {
						if e.Kind == "tool.call" {
							calls++
							c := api.Decode[api.Call](e.Data)
							if c.Origin != "ui" || c.Actor != "local-user" {
								t.Fatal(c)
							}
						}
						if e.Kind == "tool.result" {
							results++
						}
					}
					if calls != 1 || results != 1 || len(p.Requests()) != 0 {
						t.Fatal(calls, results)
					}
					if policy == "ask-unless-read-only" {
						before := asked
						_, _ = a.CallTool(ctx, id, api.Call{Name: "read", Input: api.JSON(map[string]string{"path": "out"})})
						if asked != before {
							t.Fatal("read asked")
						}
					}
				})
			}
		}
	})
}
func TestApprovalFailsClosedWithoutResponder(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, _, id, _, _ := setup(t)
		s, _ := a.Snapshot(id)
		s.Settings.Approval = "ask-always"
		_ = a.SetSettings(context.Background(), id, s.Settings)
		r, err := a.CallTool(context.Background(), id, api.Call{Name: "write", Input: api.JSON(map[string]string{"path": "no", "content": "bad"})})
		if err != nil || r.Status != "refused" {
			t.Fatal(r, err)
		}
		if _, err = os.Stat(filepath.Join(s.Project, "no")); !os.IsNotExist(err) {
			t.Fatal("refused call ran")
		}
	})
}
func TestAskUserWaitsInTurnAndSecretDoesNotReachEventsOrModel(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, q, id, p, _ := setup(t, response(api.Call{ID: "ask", Name: "ask_user", Input: api.JSON(map[string]string{"question": "Token?", "kind": "secret", "credential": "deploy"})}), final("stored"))
		ctx := context.Background()
		var mu sync.Mutex
		var events []api.Event
		a.Subscribe(func(e api.Event) {
			mu.Lock()
			events = append(events, e)
			mu.Unlock()
			if e.Kind == "question.open" {
				v := api.Decode[api.Question](e.Data)
				if err := q.Answer(ctx, id, api.Answer{Request: v.ID, Value: "never-log-secret"}); err != nil {
					t.Error(err)
				}
			}
		})
		_, _ = a.Submit(ctx, id, api.Input{Content: api.Text("go")})
		out := wait(t, a, id)
		if out.Result.Text() != "stored" {
			t.Fatal(out)
		}
		snap, _ := a.Snapshot(id)
		mu.Lock()
		data := string(api.JSON(events))
		mu.Unlock()
		if strings.Contains(data+string(api.JSON(snap))+string(api.JSON(p.Requests())), "never-log-secret") {
			t.Fatal("secret leaked")
		}
		turns := 0
		for _, e := range snap.Entries {
			if e.Kind == "turn.start" {
				turns++
			}
		}
		if turns != 1 || len(p.Requests()) != 2 {
			t.Fatal(turns)
		}
	})
}
func TestLateQuestionsEndWithoutResultsThenResumeTogether(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, q, id, p, _ := setup(t, response(api.Call{ID: "first", Name: "ask_user", Input: api.JSON(map[string]any{"question": "First?", "wait_ms": 1})}, api.Call{ID: "second", Name: "ask_user", Input: api.JSON(map[string]any{"question": "Second?", "wait_ms": 1})}), fake.Script{Require: "waiting for its late result", Response: api.Response{Content: api.Text("ordinary input while waiting"), Stop: "finished"}}, fake.Script{Require: "Late tool result", Response: api.Response{Content: api.Text("resumed"), Stop: "finished"}})
		ctx := context.Background()
		_, _ = a.Submit(ctx, id, api.Input{Content: api.Text("go")})
		out := wait(t, a, id)
		if out.Status != "completed" || len(out.Open) != 2 {
			t.Fatal(out)
		}
		snap, _ := a.Snapshot(id)
		for _, e := range snap.Entries {
			if e.Kind == "tool.result" {
				t.Fatal("stand-in recorded")
			}
		}
		_, _ = a.Submit(ctx, id, api.Input{Content: api.Text("other input")})
		if o := wait(t, a, id); o.Result.Text() != "ordinary input while waiting" {
			t.Fatal(o)
		}
		list, _ := q.List(id)
		for _, question := range list {
			value := "first answer"
			if question.Call == "second" {
				value = "second answer"
			}
			if err := q.Answer(ctx, id, api.Answer{Request: question.ID, Value: value}); err != nil {
				t.Fatal(err)
			}
		}
		out = wait(t, a, id)
		if out.Result.Text() != "resumed" {
			t.Fatal(out)
		}
		snap, _ = a.Snapshot(id)
		counts := map[string]int{}
		turns := 0
		for _, e := range snap.Entries {
			if e.Kind == "tool.result" {
				counts[e.Call]++
			}
			if e.Kind == "turn.start" {
				turns++
			}
		}
		if counts["first"] != 1 || counts["second"] != 1 || turns != 3 || len(p.Requests()) != 3 {
			t.Fatal(counts, turns)
		}
	})
}
