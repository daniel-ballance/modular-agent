package api

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"
)

var ErrCapacity = errors.New("capacity limit")

// JobReportBytes bounds the encoded input reserved for a reporting job.
const JobReportBytes = 1 << 20

var ErrTenantTokens = errors.New("tenantTokens limit")
var ErrAuthority = errors.New("authority refused")
var ErrTenantForbidden = errors.New("tenant access forbidden")

var ErrSettingsBusy = errors.New("settings cannot change during a turn")

var ErrProcessStopped = errors.New("agent process stopped")

// Rights names the operations defined by the shared data binding.
var Rights = []string{"watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate", "administer"}

type Actor struct {
	ID     string   `json:"id"`
	Kind   string   `json:"kind"`
	Rights []string `json:"rights"`
}
type sessionScopeKey struct{}

// WithSessionScope carries the operator's connection scope to mediated work.
func WithSessionScope(ctx context.Context, permits func(project, tenant string) bool) context.Context {
	return context.WithValue(ctx, sessionScopeKey{}, permits)
}

func SessionScopeAllows(ctx context.Context, project, tenant string) bool {
	permits, _ := ctx.Value(sessionScopeKey{}).(func(string, string) bool)
	return permits == nil || permits(project, tenant)
}

type sessionSettingsKey struct{}

// WithSessionSettings sets trusted initial settings for a new session.
func WithSessionSettings(ctx context.Context, settings Settings) context.Context {
	return context.WithValue(ctx, sessionSettingsKey{}, settings)
}

func SessionSettings(ctx context.Context) (Settings, bool) {
	settings, ok := ctx.Value(sessionSettingsKey{}).(Settings)
	return settings, ok
}

type reopeningKey struct{}

// WithReopenedSession identifies a session.start hook dispatched on reopen.
func WithReopenedSession(ctx context.Context) context.Context {
	return context.WithValue(ctx, reopeningKey{}, true)
}

func IsReopenedSession(ctx context.Context) bool {
	v, _ := ctx.Value(reopeningKey{}).(bool)
	return v
}

type actingViaKey struct{}

func WithActingVia(ctx context.Context, actor string) context.Context {
	return context.WithValue(ctx, actingViaKey{}, actor)
}
func ActingVia(ctx context.Context) string { a, _ := ctx.Value(actingViaKey{}).(string); return a }

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
	Deadline                                                            *time.Time `json:",omitempty"`
	Defer, Pause                                                        bool
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
	Recorded(Session) []Question
	Connect(string, string) func()
}
type SecretReceipt struct {
	Session, Request, Name, Actor, ID string
}
type SecretDecision string

const (
	SecretActivated  SecretDecision = "activated"
	SecretSuperseded SecretDecision = "superseded"
	SecretDiscarded  SecretDecision = "discarded"
)

type StagedCredentials interface {
	Credentials
	Stage(ctx context.Context, session, request, name, actor, value string) (SecretReceipt, error)
	LookupStaged(ctx context.Context, session, request string) (SecretReceipt, bool, error)
	Activate(context.Context, SecretReceipt) (SecretDecision, error)
	Discard(ctx context.Context, session, request string) error
}

type SecretDestination interface{ CanStore(string) bool }
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
	ErrWriterLost       = errors.New("history writer access lost")
	ErrSessionLost      = errors.New("session interrupted; reopen to recover")
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
	Session, Turn, Step string
	Call                Call
	ToolSource          *ToolRegistration
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
		if e.Kind == "model" && e.Turn == "" {
			total.Add(Decode[struct{ Usage Usage }](e.Data).Usage)
		}
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
			if e.Turn == "" {
				continue
			}
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
	if handoffs := InterfaceHandoffs(s); len(handoffs) != 0 {
		for _, e := range s.LiveEntries() {
			if handoffs[e.Call].ID != "" && e.WasKind("tool.result") {
				delete(calls, e.Call)
			}
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
