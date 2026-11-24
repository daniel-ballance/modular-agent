package questions_test

import (
	"context"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLateUIQuestionResumesAndConcurrentAnswersCloseOnce(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, q, id, _, _ := setup(t, final("UI answer continued"))
		ctx := context.Background()
		r, err := a.CallTool(ctx, id, api.Call{Name: "ask_user", Input: api.JSON(map[string]any{"question": "Which?", "wait_ms": 1})})
		if err != nil || r.Status != "open" {
			t.Fatal(r, err)
		}
		list, _ := q.List(id)
		var accepted atomic.Int32
		var wg sync.WaitGroup
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if q.Answer(ctx, id, api.Answer{Request: list[0].ID, Value: "cobalt"}) == nil {
					accepted.Add(1)
				}
			}()
		}
		wg.Wait()
		if accepted.Load() != 1 {
			t.Fatal(accepted.Load())
		}
		out := wait(t, a, id)
		if out.Result.Text() != "UI answer continued" {
			t.Fatal(out)
		}
		snap, _ := a.Snapshot(id)
		n := 0
		for _, e := range snap.Entries {
			if e.Kind == "tool.result" && e.Call == r.Call {
				n++
			}
		}
		if n != 1 {
			t.Fatal(n)
		}
	})
}
func TestLaterGateCannotChangeApprovedArgumentsOrUseRevokedAllow(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, kind := range []string{"mutation", "revocation"} {
			t.Run(kind, func(t *testing.T) {
				p := fake.New()
				h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake"})
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				if err = h.Load(api.Plugin{Name: "later-gate", Setup: func(a api.API) error {
					return a.Handle("runtime.tool.before", "last", func(ctx context.Context, v any) (api.Decision, error) {
						check := v.(api.ToolCheck)
						if kind == "mutation" {
							check.Call.Input = api.JSON(map[string]string{"path": "different", "content": "bad"})
						} else {
							var rights []string
							for _, r := range api.Rights {
								if r != "approve" {
									rights = append(rights, r)
								}
							}
							if err := a.Grant(ctx, check.Session, api.Actor{ID: "local-user", Rights: rights}); err != nil {
								return api.Decision{}, err
							}
						}
						return api.Decision{Value: check}, nil
					})
				}}); err != nil {
					t.Fatal(err)
				}
				a := h.API()
				id, _ := a.New(context.Background(), t.TempDir())
				runtimetest.Publish(t, a, id)
				s, _ := a.Snapshot(id)
				s.Settings.Approval = "ask-always"
				_ = a.SetSettings(context.Background(), id, s.Settings)
				v, _ := a.Get("questions")
				q := v.(api.Questions)
				defer q.Connect(id, "local-user")()
				a.Subscribe(func(e api.Event) {
					if e.Kind == "question.open" {
						question := api.Decode[api.Question](e.Data)
						if err := q.Answer(context.Background(), id, api.Answer{Request: question.ID, Value: "allow"}); err != nil {
							t.Error(err)
						}
					}
				})
				r, err := a.CallTool(context.Background(), id, api.Call{Name: "write", Input: api.JSON(map[string]string{"path": "original", "content": "ok"})})
				if err != nil || r.Status != "refused" {
					t.Fatal(r, err)
				}
			})
		}
	})
}
func TestActorCommandsCannotBorrowOwnerAuthority(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, _, id, _, _ := setup(t)
		ctx := context.Background()
		_ = a.Grant(ctx, id, api.Actor{ID: "guest", Rights: []string{"input", "watch"}})
		for _, command := range []string{"/model fake-alt", "/approval off", "/cancel"} {
			if _, err := a.Submit(api.AsActor(ctx, "guest"), id, api.Input{Content: api.Text(command)}); err == nil {
				t.Fatal("borrowed owner authority", command)
			}
		}
	})
}

type badStore struct{}

func (badStore) Get(context.Context, string) (string, error) { return "", errors.New("missing") }
func (badStore) Stage(_ context.Context, _, _, _, _, value string) (api.SecretReceipt, error) {
	return api.SecretReceipt{}, fmt.Errorf("do not expose %s", value)
}
func (badStore) LookupStaged(context.Context, string, string) (api.SecretReceipt, bool, error) {
	return api.SecretReceipt{}, false, nil
}
func (badStore) Activate(context.Context, api.SecretReceipt) (api.SecretDecision, error) {
	return "", errors.New("unexpected activation")
}
func (badStore) Discard(context.Context, string, string) error { return nil }
func TestSecretDestinationRefusedBeforeAskAndWriteErrorsDoNotLeak(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, bad := range []bool{false, true} {
			t.Run(fmt.Sprint(bad), func(t *testing.T) {
				h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Runtime: runtimetest.Plugin(t), Provider: fake.New().Plugin(), Model: "fake"})
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				if bad {
					if err = h.Load(api.Plugin{Name: "bad-store", Setup: func(a api.API) error { return a.Provide("credentials", badStore{}) }}); err != nil {
						t.Fatal(err)
					}
				}
				a := h.API()
				id, _ := a.New(context.Background(), t.TempDir())
				runtimetest.Publish(t, a, id)
				v, _ := a.Get("questions")
				q := v.(api.Questions)
				events := ""
				a.Subscribe(func(e api.Event) { events += string(api.JSON(e)) })
				answer, err := q.Ask(context.Background(), api.Question{Session: id, Key: "secret", Kind: "secret", Prompt: "Token?", Credential: "deploy", Wait: time.Millisecond, Defer: true})
				list, _ := q.List(id)
				if !bad {
					if err != nil || !answer.Declined || len(list) != 0 {
						t.Fatal("unavailable destination was asked", err, list)
					}
					return
				}
				if !errors.Is(err, api.ErrQuestionOpen) {
					t.Fatal(err)
				}
				err = q.Answer(context.Background(), id, api.Answer{Request: list[0].ID, Value: "raw-private-secret"})
				if err == nil || strings.Contains(err.Error()+events, "raw-private-secret") {
					t.Fatal("write error leaked secret")
				}
				list, _ = q.List(id)
				if !list[0].Answerable {
					t.Fatal("failed write closed question")
				}
			})
		}
	})
}
func TestQuestionOnAbandonedBranchIsNotReused(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, q, id, _, _ := setup(t)
		ctx := context.Background()
		anchor, _ := a.Record(ctx, id, api.Entry{Kind: "anchor"})
		question := api.Question{Session: id, Key: "branch-key", Kind: "text", Prompt: "Color?", Wait: time.Millisecond, Defer: true}
		_, _ = q.Ask(ctx, question)
		list, _ := q.List(id)
		_ = q.Answer(ctx, id, api.Answer{Request: list[0].ID, Value: "old answer"})
		if err := a.Move(ctx, id, anchor.ID, false); err != nil {
			t.Fatal(err)
		}
		answer, err := q.Ask(ctx, question)
		if !errors.Is(err, api.ErrQuestionOpen) || answer.Value != "" {
			t.Fatal("abandoned answer reused", answer, err)
		}
	})
}
func TestSessionCloseSettlesParkedCallsAndLosesNoQuestionRecord(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		a, q, id, _, _ := setup(t, response(api.Call{ID: "parked", Name: "ask_user", Input: api.JSON(map[string]any{"question": "Later?", "wait_ms": 1})}))
		ctx := context.Background()
		_, _ = a.Submit(ctx, id, api.Input{Content: api.Text("go")})
		out := wait(t, a, id)
		if len(out.Open) != 1 {
			t.Fatal(out)
		}
		if _, err := a.Fork(ctx, id, ""); err == nil {
			t.Fatal("forked live work")
		}
		if err := a.Move(ctx, id, "", false); err == nil {
			t.Fatal("moved live work")
		}
		list, _ := q.List(id)
		request := list[0].ID
		if err := a.CloseSession(id); err != nil {
			t.Fatal(err)
		}
		if err := a.Open(ctx, id); err != nil {
			t.Fatal(err)
		}
		if err := q.Answer(ctx, id, api.Answer{Request: request, Value: "too late"}); err == nil {
			t.Fatal("closed question answered")
		}
		s, _ := a.Snapshot(id)
		n := 0
		for _, e := range s.Entries {
			if e.Kind == "tool.result" && e.Call == "parked" {
				n++
				if api.Decode[api.ToolResult](e.Data).Status != "cancelled" {
					t.Fatal(e)
				}
			}
		}
		if n != 1 {
			t.Fatal(n)
		}
	})
}
