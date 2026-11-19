package api

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"
)

var ErrTenantTokens = errors.New("tenantTokens limit")
var ErrTenantForbidden = errors.New("tenant access forbidden")

var ErrProcessStopped = errors.New("agent process stopped")

// Rights names the operations defined by the shared data binding.
var Rights = []string{"watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate", "administer"}

type Actor struct {
	ID     string   `json:"id"`
	Kind   string   `json:"kind"`
	Rights []string `json:"rights"`
}
type actorKey struct{}

func AsActor(ctx context.Context, actor string) context.Context {
	return context.WithValue(ctx, actorKey{}, actor)
}
func Acting(ctx context.Context) string {
	if s, _ := ctx.Value(actorKey{}).(string); s != "" {
		return s
	}
	return "local-user"
}

type ToolRegistration struct {
	Plugin     string `json:"plugin"`
	ToolSource string `json:"toolSource"`
}

type Question struct {
	ApprovalCall                                                        *Call             `json:",omitempty"`
	Definition                                                          *Tool             `json:",omitempty"`
	Source                                                              *ToolRegistration `json:",omitempty"`
	Wire, Details                                                       json.RawMessage
	ID, Key, Session, Turn, Step, Call, Actor, Kind, Prompt, Credential string
	Options, Allowed, Path                                              []string
	Wait                                                                time.Duration
	Defer                                                               bool
	Answerable                                                          bool
}
type Answer struct {
	Request, Actor, Value string
	Reason, Stored        string
	Declined              bool
	Via                   []ActorRef
}
type ActorRef struct{ Session, Actor string }
type Questions interface {
	Ask(context.Context, Question) (Answer, error)
	Answer(context.Context, string, Answer) error
	List(string) ([]Question, error)
	Connect(string, string) func()
}
type SecretDestination interface{ CanStore(string) bool }
type SecretWriter interface {
	Put(context.Context, string, string) error
}
type Job struct {
	ID, Key, Session, Turn, Call, Actor, Owner, Kind, State string
	StartEntry                                              string
	Contributors                                            []string `json:",omitempty"`
	Rights                                                  []string
	Detail                                                  json.RawMessage
	Outcome                                                 Outcome
	Report                                                  bool
	ResultPresent                                           bool `json:",omitempty"`
	CleanupUnconfirmed                                      bool `json:",omitempty"`
}
type Jobs interface {
	Start(context.Context, Job, func(context.Context) Outcome) (Job, error)
	List(string) ([]Job, error)
	Cancel(context.Context, string, string) error
	Wait(context.Context, string, string) (Job, error)
	Recover(context.Context, Job, func(context.Context) Outcome) error
}

// ExternalJobs is the jobs capability's transport for registered stdio owners.
// Each operation is checked against the owner name and the open session.
type ExternalJobs interface {
	StartExternal(context.Context, Job) (Job, bool, error)
	Unfinished(string, string) ([]Job, error)
	ResumeExternal(string, string) error
	ProgressExternal(context.Context, string, string, Content) error
	EndExternal(context.Context, string, string, Outcome, bool) error
}

var (
	ErrJobNotFound      = errors.New("job not found")
	ErrJobReportRefused = errors.New("job report refused")
	ErrUnknownModel     = errors.New("model is not offered")
	ErrJobCommitLost    = errors.New("job commit unconfirmed")
	ErrJobCleanupLost   = errors.New("job cleanup unconfirmed")
)

type JobCanceller func(context.Context, string) error
type JobOwnerLookup func(string) JobCanceller

// JobActor names the derived actor under which a job's report runs.
func JobActor(id string) string { return "job:" + id }

// ErrQuestionOpen is control flow for a check or tool, not a tool result.
// QuestionDeclined preserves the identity of a timeout or unavailable responder.
type QuestionDeclined struct{ Request, Reason string }

func (e *QuestionDeclined) Error() string { return e.Reason }

var ErrQuestionOpen = &openError{}

type openError struct{}

func (*openError) Error() string { return "question remains open" }

type toolProgressKey struct{}

func WithToolProgress(ctx context.Context, emit func(Content)) context.Context {
	return context.WithValue(ctx, toolProgressKey{}, emit)
}

// ToolProgress delivers typed progress when the caller supports it.
func ToolProgress(ctx context.Context, content Content) bool {
	emit, _ := ctx.Value(toolProgressKey{}).(func(Content))
	if emit == nil {
		return false
	}
	emit(content)
	return true
}

type executionKey struct{}
type questionOrderKey struct{}
type questionOrder struct {
	call string
	n    atomic.Uint64
}
type Execution struct {
	Session, Turn string
	Call          Call
	ToolSource    *ToolRegistration
}

func WithExecution(ctx context.Context, e Execution) context.Context {
	if e.Call.ID != "" {
		if order, _ := ctx.Value(questionOrderKey{}).(*questionOrder); order == nil || order.call != e.Call.ID {
			ctx = context.WithValue(ctx, questionOrderKey{}, &questionOrder{call: e.Call.ID})
		}
	}
	return context.WithValue(ctx, executionKey{}, e)
}

// NextQuestion returns the call-local ordinal for this execution attempt.
// Zero means the asker was not invoked in a managed call context.
func NextQuestion(ctx context.Context, call string) uint64 {
	if order, _ := ctx.Value(questionOrderKey{}).(*questionOrder); order != nil && order.call == call {
		return order.n.Add(1)
	}
	return 0
}
func Executing(ctx context.Context) Execution {
	e, _ := ctx.Value(executionKey{}).(Execution)
	return e
}

// SessionUsage counts this session's turns and its jobs, without counting a report twice.
func SessionUsage(s Session) Usage {
	var total Usage
	turns := map[string]Usage{}
	jobs := map[string]Usage{}
	for _, e := range s.Branch() {
		if e.Kind == "turn.end" {
			turns[e.Turn] = Decode[Outcome](e.Data).Usage
		}
		if e.Kind == "job.end" {
			j := Decode[Job](e.Data)
			if j.Session == s.ID {
				jobs[j.ID] = j.Outcome.Usage
			}
		}
	}
	for _, u := range turns {
		total.Add(u)
	}
	for _, u := range jobs {
		total.Add(u)
	}
	return total
}

// OpenCalls derives late work from the selected branch. No synthetic result is stored.
func OpenCalls(s Session) []Call {
	calls := map[string]Call{}
	var order []string
	for _, e := range s.Branch() {
		add := func(c Call) {
			if c.ID == "" {
				return
			}
			if _, ok := calls[c.ID]; !ok {
				order = append(order, c.ID)
			}
			calls[c.ID] = c
		}
		switch e.Kind {
		case "tool.call", "tool.started":
			add(Decode[Call](e.Data))
		case "model":
			for _, part := range e.Content {
				if part.Call == nil {
					continue
				}
				call := *part.Call
				call.Step, call.Actor, call.Origin = e.Step, e.Actor, "model"
				add(call)
			}
		}
		if e.WasKind("tool.result") {
			delete(calls, e.Call)
		}
	}
	var out []Call
	for _, id := range order {
		if c, ok := calls[id]; ok {
			out = append(out, c)
		}
	}
	return out
}
