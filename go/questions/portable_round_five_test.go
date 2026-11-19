package questions_test

import (
	"context"
	"errors"
	"modular/api"
	"modular/harness"
	"modular/questions"
	"slices"
	"testing"
	"time"
)

func TestPortableImplicitKeysAndQuestionCloseReasons(t *testing.T) {
	h := harness.New()
	defer h.Close()
	if err := h.Load(questions.Plugin()); err != nil {
		t.Fatal(err)
	}
	a := h.API()
	id, err := a.New(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	v, err := a.Get("questions")
	if err != nil {
		t.Fatal(err)
	}
	q := v.(api.Questions)
	askTwice := func() {
		ctx := api.WithExecution(context.Background(), api.Execution{Session: id, Call: api.Call{ID: "call-42", Actor: "local-user"}})
		for _, tc := range []struct{ kind, reason string }{{"text", "timeLimit"}, {"approval", "refused"}} {
			_, err := q.Ask(ctx, api.Question{Kind: tc.kind, Prompt: "Proceed?", Wait: time.Millisecond})
			var declined *api.QuestionDeclined
			if !errors.As(err, &declined) || declined.Reason != tc.reason {
				t.Fatalf("%s: %v", tc.kind, err)
			}
		}
	}
	askTwice()
	askTwice() // A repeat must find the same two answers with no new questions.
	requests, err := q.List(id)
	if err != nil || len(requests) != 2 {
		t.Fatal(requests, err)
	}
	var keys []string
	for _, r := range requests {
		if r.Answerable {
			t.Fatal(r)
		}
		keys = append(keys, r.Key)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, []string{"call:call-42:1", "call:call-42:2"}) {
		t.Fatal(keys)
	}
}
