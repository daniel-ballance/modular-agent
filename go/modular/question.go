package modular

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/questions"
)

type Question struct {
	ID         string          `json:"id,omitempty"`
	SessionID  string          `json:"sessionId,omitempty"`
	Kind       string          `json:"kind"`
	Question   string          `json:"question"`
	Details    json.RawMessage `json:"details,omitempty"`
	Options    []string        `json:"options,omitempty"`
	Call       *ToolCall       `json:"call,omitempty"`
	Credential string          `json:"credential,omitempty"`
	Deadline   *time.Time      `json:"deadline,omitempty"`
}
type Answer struct {
	Value    string `json:"value,omitempty"`
	Declined bool   `json:"declined,omitempty"`
	Reason   string `json:"reason,omitempty"`
	// Stored names the credential; the submitted secret is never returned.
	Stored   string `json:"stored,omitempty"`
	provided bool
}

func Value(value string) Answer  { return Answer{Value: value, provided: true} }
func Secret(value string) Answer { return Value(value) }

func Allow() Answer                { return Answer{Value: "allow"} }
func Decline(reason string) Answer { return Answer{Declined: true, Reason: reason} }

type QuestionHandler func(context.Context, Question) (Answer, error)

// LeftOpen signals that a call must be continued when its question is answered.
var LeftOpen = api.ErrQuestionOpen

type AskOptions struct {
	Wait time.Duration
	Then string
}

type questionRouter struct {
	a        api.API
	handler  QuestionHandler
	mu       sync.Mutex
	sessions map[string]*questionSession
}
type questionSession struct {
	ctx        context.Context
	cancel     context.CancelFunc
	handler    QuestionHandler
	disconnect func()
	responding map[string]bool
}

func newQuestionRouter(a api.API, h QuestionHandler) *questionRouter {
	return &questionRouter{a: a, handler: h, sessions: map[string]*questionSession{}}
}
func (q *questionRouter) plugin() api.Plugin {
	var unsubscribe func()
	return api.Plugin{Name: "sdk-questions", Setup: func(a api.API) error {
		if err := a.Handle("session.start", "first", func(_ context.Context, v any) (api.Decision, error) {
			s := v.(api.Session)
			if s.Actor == localActor {
				q.attach(s.ID, q.handler)
			}
			return api.Decision{}, nil
		}); err != nil {
			return err
		}
		for _, point := range []string{"session.end", "session.stop"} {
			if err := a.Handle(point, "first", func(_ context.Context, v any) (api.Decision, error) { q.detach(v.(string)); return api.Decision{}, nil }); err != nil {
				return err
			}
		}
		unsubscribe = a.Subscribe(q.event)
		return nil
	}, Close: func() error {
		if unsubscribe != nil {
			unsubscribe()
		}
		q.mu.Lock()
		defer q.mu.Unlock()
		for id, s := range q.sessions {
			s.cancel()
			if s.disconnect != nil {
				s.disconnect()
			}
			delete(q.sessions, id)
		}
		return nil
	}}
}
func (q *questionRouter) manager() *questions.Manager {
	v, _ := q.a.Get("questions")
	return v.(*questions.Manager)
}
func (q *questionRouter) attach(id string, h QuestionHandler) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if old := q.sessions[id]; old != nil {
		old.cancel()
		if old.disconnect != nil {
			old.disconnect()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	next := &questionSession{ctx: ctx, cancel: cancel, handler: h, responding: map[string]bool{}}
	if h != nil {
		next.disconnect = q.manager().Connect(id, localActor)
	}
	q.sessions[id] = next
}
func (q *questionRouter) detach(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if old := q.sessions[id]; old != nil {
		old.cancel()
		if old.disconnect != nil {
			old.disconnect()
		}
		delete(q.sessions, id)
	}
}
func answerQuestion(ctx context.Context, handler QuestionHandler, q Question) (a Answer, err error) {
	defer func() {
		if recover() != nil {
			err = fmt.Errorf("question handler panicked")
		}
	}()
	return handler(ctx, q)
}

func sdkQuestion(raw api.Question) Question {
	q := Question{ID: raw.ID, SessionID: raw.Session, Kind: raw.Kind, Question: raw.Prompt, Details: raw.Details, Options: raw.Options, Credential: raw.Credential}
	if raw.ApprovalCall != nil {
		var c ToolCall
		_ = decodeInto(portable.Call(*raw.ApprovalCall), &c)
		q.Call = &c
	}
	return q
}

func (q *questionRouter) event(e api.Event) {
	if e.Kind != "question.open" {
		return
	}
	raw := api.Decode[api.Question](e.Data)
	q.mu.Lock()
	s := q.sessions[raw.Session]
	if s == nil || s.handler == nil || s.responding[raw.ID] {
		q.mu.Unlock()
		return
	}
	s.responding[raw.ID] = true
	q.mu.Unlock()
	go func() {
		defer func() { q.mu.Lock(); delete(s.responding, raw.ID); q.mu.Unlock() }()
		ctx := api.AsActor(s.ctx, localActor)
		question := sdkQuestion(raw)
		if raw.Wait > 0 && !raw.Defer {
			deadline := time.Now().Add(raw.Wait)
			question.Deadline = &deadline
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, deadline)
			defer cancel()
		}
		ans, err := answerQuestion(ctx, s.handler, question)
		if err != nil {
			ans = Decline("question handler failed")
		} else if ans == (Answer{}) {
			ans = Decline("")
		}
		if ctx.Err() != nil {
			return
		}
		m := q.manager()
		answer := api.Answer{Request: raw.ID, Value: ans.Value, Declined: ans.Declined, Reason: ans.Reason}
		if m.Answer(ctx, raw.Session, answer) == api.ErrInvalidAnswer {
			_ = m.Answer(ctx, raw.Session, api.Answer{Request: raw.ID, Declined: true, Reason: "invalid answer"})
		}
	}()
}
