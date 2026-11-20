package subagents_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"strings"
	"sync"
	"testing"
)

func TestNestedApprovalsAndSecretReachOnlyTopCredentialBoundary(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		p := scripts(func(_ context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			if first(r) == "level one" && models(r) == 0 {
				return call("delegate", "grandchild", map[string]any{"task": "level two", "background": false}), nil
			}
			if first(r) == "level two" && models(r) == 0 {
				return call("ask_user", "secret", map[string]string{"kind": "secret", "question": "Deployment token?", "credential": "nested/deploy"}), nil
			}
			return text("stored nested/deploy"), nil
		})
		h, id, _ := newAgent(t, p, 3)
		a := h.API()
		ctx := context.Background()
		s, _ := a.Snapshot(id)
		s.Settings.Approval = "ask-unless-read-only"
		if err := a.SetSettings(ctx, id, s.Settings); err != nil {
			t.Fatal(err)
		}
		v, _ := a.Get("questions")
		q := v.(api.Questions)
		defer q.Connect(id, "local-user")()
		approvals, secrets := 0, 0
		allEvents := ""
		var mu sync.Mutex
		a.Subscribe(func(e api.Event) {
			mu.Lock()
			allEvents += string(api.JSON(e))
			mu.Unlock()
			if e.Kind == "question.open" && e.Session == id {
				question := api.Decode[api.Question](e.Data)
				value := "allow"
				mu.Lock()
				if question.Kind == "secret" {
					secrets++
					value = "private-nested-value"
					if len(question.Path) != 2 {
						t.Error(question.Path)
					}
				} else {
					approvals++
				}
				mu.Unlock()
				if err := q.Answer(ctx, id, api.Answer{Request: question.ID, Value: value}); err != nil {
					t.Error(err)
				}
			}
		})
		r, err := a.CallTool(ctx, id, api.Call{Name: "delegate", Input: api.JSON(map[string]any{"task": "level one", "background": false})})
		if err != nil || !strings.Contains(r.Content.Text(), "stored") {
			t.Fatal(r, err)
		}
		mu.Lock()
		defer mu.Unlock()
		if approvals != 3 || secrets != 1 {
			t.Fatal(approvals, secrets)
		}
		list, _ := a.List("")
		if strings.Contains(allEvents+string(api.JSON(list))+string(api.JSON(p.Requests())), "private-nested-value") {
			t.Fatal("nested secret leaked")
		}
		v, _ = a.Get("credentials")
		value, err := v.(api.Credentials).Get(ctx, "nested/deploy")
		if err != nil || value != "private-nested-value" {
			t.Fatal("nested secret not stored")
		}
	})
}
