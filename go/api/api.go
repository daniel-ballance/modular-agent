// Package api is the version 1 in-process binding of the description's contracts.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

// ErrUnknownOutcome means execution may have had effects but no reliable result.
var ErrUnknownOutcome = errors.New("call outcome unknown")
var ErrInputConflict = errors.New("input disposition conflicts with current session state")

func ID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func JSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
func Decode[T any](v json.RawMessage) T { var x T; _ = json.Unmarshal(v, &x); return x }

type Part struct {
	Wire json.RawMessage `json:"wire,omitempty"`
	Type string          `json:"type"`
	Text string          `json:"text,omitempty"`
	Call *Call           `json:"call,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}
type Content []Part

func Text(s string) Content { return Content{{Type: "text", Text: s}} }
func (c Content) Text() string {
	s := ""
	for _, p := range c {
		if p.Type == "text" {
			s += p.Text
		}
	}
	return s
}

type Call struct {
	ParentCall string          `json:"parentCallId,omitempty"`
	Wire       json.RawMessage `json:"wire,omitempty"`
	Step       string          `json:"step,omitempty"`
	Reference  string          `json:"reference,omitempty"`
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Input      json.RawMessage `json:"input"`
	Origin     string          `json:"origin,omitempty"`
	Actor      string          `json:"actor,omitempty"`
}
type ToolResult struct {
	ProcessingError error           `json:"-"`
	Returns         json.RawMessage `json:"-"` // schema of the registration actually dispatched
	NotDispatched   bool            `json:"-"` // result reports a local preflight failure, not execution
	Wire            json.RawMessage `json:"wire,omitempty"`
	Name            string          `json:"name,omitempty"`
	Structured      json.RawMessage `json:"structured,omitempty"`
	Data            json.RawMessage `json:"data,omitempty"`
	Copies          []string        `json:"copies,omitempty"`
	Reference       string          `json:"reference,omitempty"`
	Call            string          `json:"call"`
	Status          string          `json:"status"`
	Content         Content         `json:"content"`
}
type Tool struct {
	UsesWorkingEnvironment bool            `json:"-"` // set by the host adapter, not a wire hint
	Callers                []string        `json:"callers"`
	Wire                   json.RawMessage `json:"wire,omitempty"`
	Destructive            bool            `json:"destructive"`
	External               bool            `json:"external"`
	Output                 json.RawMessage `json:"output,omitempty"`
	Data                   json.RawMessage `json:"data,omitempty"`
	Name                   string          `json:"name"`
	Description            string          `json:"description"`
	Input                  json.RawMessage `json:"input"`
	ReadOnly               bool            `json:"read_only"`
	SafeRepeat             bool            `json:"safe_repeat"`
	Parallel               bool            `json:"parallel"`
}
type Entry struct {
	Wire               json.RawMessage `json:"wire,omitempty"`
	InputKey           string          `json:"input_key,omitempty"`
	InputRef           string          `json:"input_ref,omitempty"`
	InputRefs          []string        `json:"input_refs,omitempty"`
	JobKey             string          `json:"job_key,omitempty"`
	TracksStepAfter    bool            `json:"tracks_step_after,omitempty"`
	SafeToRepeat       *bool           `json:"safe_to_repeat,omitempty"`
	OfferedTools       *[]string       `json:"offered_tools,omitempty"`
	Point              string          `json:"point,omitempty"`
	OpenWorld          *bool           `json:"open_world,omitempty"`
	OutsideEnvironment bool            `json:"outside_environment,omitempty"`
	OriginalKind       string          `json:"original_kind,omitempty"`
	ID                 string          `json:"id"`
	Parent             string          `json:"parent,omitempty"`
	Session            string          `json:"session"`
	Turn               string          `json:"turn,omitempty"`
	Step               string          `json:"step,omitempty"`
	Call               string          `json:"call,omitempty"`
	Actor              string          `json:"actor"`
	OperatorAdmission  bool            `json:"operator_admission,omitempty"`
	Writer             string          `json:"writer"`
	Time               time.Time       `json:"time"`
	Kind               string          `json:"kind"`
	Visible            bool            `json:"visible"`
	Job                string          `json:"job,omitempty"`
	Copies             []string        `json:"copies,omitempty"`
	Content            Content         `json:"content,omitempty"`
	Data               json.RawMessage `json:"data,omitempty"`
}
type Settings struct {
	ModelTools   *[]string `json:"modelTools"`
	Approval     string    `json:"approval,omitempty"`
	Model        string    `json:"model"`
	Thinking     string    `json:"thinking"`
	MaxSteps     int       `json:"max_steps"`
	MaxOutput    int       `json:"max_output"`
	ContextLimit int       `json:"context_limit"`
}
type Session struct {
	HistoryMeta json.RawMessage  `json:"historyMeta,omitempty"`
	Tenant      string           `json:"tenant,omitempty"`
	Limit       *[]string        `json:"limit,omitempty"` // absent means uncapped
	Actors      map[string]Actor `json:"actors,omitempty"`
	Parent      string           `json:"parent,omitempty"`
	ParentActor string           `json:"parent_actor,omitempty"`
	Ceiling     []string         `json:"ceiling,omitempty"`
	Depth       int              `json:"depth,omitempty"`
	Version     int              `json:"version"`
	ID          string           `json:"id"`
	Project     string           `json:"project"`
	Settings    Settings         `json:"settings"`
	Actor       string           `json:"actor"`
	Plugins     []string         `json:"plugins"`
	Position    string           `json:"position,omitempty"`
	ForkedFrom  string           `json:"forked_from,omitempty"`
	Entries     []Entry          `json:"entries"`
}

// InputID reads the taken admission in both old and current in-process records.
func (e Entry) InputID() string {
	if e.InputRef != "" {
		return e.InputRef
	}
	return Decode[string](e.Data)
}

// LiveEntries excludes a portable fork's display-only prefix.
func (s Session) LiveEntries() []Entry {
	if s.ForkedFrom != "" {
		for i, e := range s.Entries {
			if len(e.Copies) == 0 && !e.IsErased() {
				return s.Entries[i:]
			}
		}
		return nil
	}
	return s.Entries
}

func (s Session) Branch() []Entry {
	byID := map[string]Entry{}
	for _, e := range s.Entries {
		byID[e.ID] = e
	}
	var reverse []Entry
	for id := s.Position; id != ""; {
		e, ok := byID[id]
		if !ok {
			break
		}
		reverse = append(reverse, e)
		id = e.Parent
	}
	out := make([]Entry, len(reverse))
	for i, e := range reverse {
		out[len(reverse)-1-i] = e
	}
	return out
}

type Input struct {
	ResultSchema         json.RawMessage `json:"resultSchema,omitempty"`
	ID, Key, Actor, When string
	Answer               string    `json:",omitempty"`
	ReleasedBy           string    `json:",omitempty"`
	Taken                string    `json:",omitempty"`
	Parked               *bool     `json:",omitempty"`
	JobRights            []string  `json:",omitempty"`
	ConnectionRights     *[]string `json:",omitempty"`
	ViaActor             string    `json:",omitempty"`
	Content              Content
	Calls                []Call
	Copies               []string
	Job                  string
}
type Receipt struct {
	ID, When  string
	Duplicate bool
	Erased    bool
	Command   string
}
type Outcome struct {
	Value       json.RawMessage `json:"value,omitempty"`
	Interrupted bool            `json:"interrupted,omitempty"`
	Copies      []string        `json:"copies,omitempty"`
	Open        []Call          `json:"open,omitempty"`
	Status      string          `json:"status"`
	Error       string          `json:"error,omitempty"`
	Result      Content         `json:"result,omitempty"`
	Steps       int             `json:"steps"`
	Usage       Usage           `json:"usage"`
	Returned    []Input         `json:"returned,omitempty"`
}
type Usage struct {
	Input      int     `json:"input"`
	Output     int     `json:"output"`
	Cached     int     `json:"cached"`
	CacheWrite int     `json:"cache_write,omitempty"`
	Cost       float64 `json:"cost,omitempty"`
}

func (u *Usage) Add(v Usage) {
	u.Input += v.Input
	u.Output += v.Output
	u.Cached += v.Cached
	u.CacheWrite += v.CacheWrite
	u.Cost += v.Cost
}

const SessionInterrupted = "session.interrupted"

type Event struct {
	Kind         string          `json:"kind"`
	Method       string          `json:"-"` // request method for a gated reply
	ErasureEpoch int             `json:"-"` // freshness at the start of delivery
	Session      string          `json:"session,omitempty"`
	Turn         string          `json:"turn,omitempty"`
	Step         string          `json:"step,omitempty"`
	Call         string          `json:"call,omitempty"`
	Actor        string          `json:"actor,omitempty"`
	Time         time.Time       `json:"time"`
	Data         json.RawMessage `json:"data,omitempty"`
}
type Output struct {
	Event Event
	Hold  bool
}
type Rule string

const (
	Observe     Rule = "observe"
	Gate        Rule = "gate"
	Transform   Rule = "transform"
	FirstAnswer Rule = "first-answer"
	Collect     Rule = "collect"
)

type Decision struct {
	Value                any
	Answer, Stop, Refuse bool
}
type Handler func(context.Context, any) (Decision, error)
type Command func(context.Context, string, []string) (string, error)
type Plugin struct {
	Name, Replaces string
	Setup          func(API) error
	Close          func() error
}

// API is identity-bound. Get and Snapshot are trusted raw plugin access.
// Interfaces must use View and gated event subscriptions for recipient output.
type API interface {
	Authorize(string, string, string) bool
	Grant(context.Context, string, Actor) error
	BindChild(context.Context, string, string, string) error
	CallTool(context.Context, string, Call) (ToolResult, error)
	Provide(string, any) error
	Get(string) (any, error)
	All(string) []any
	Define(string, Rule) error
	Handle(string, string, Handler) error
	Invoke(context.Context, string, any) (any, error)
	RegisterCommand(string, Command) error
	Command(context.Context, string, string) (string, error)
	Commands() []string
	New(context.Context, string) (string, error)
	Open(context.Context, string) error
	List(string) ([]Session, error)
	Snapshot(string) (Session, error)
	View(context.Context, string) (Session, error)
	Record(context.Context, string, Entry) (Entry, error)
	Move(context.Context, string, string, bool) error
	Fork(context.Context, string, string) (string, error)
	Erase(context.Context, string, []string) error
	SetSettings(context.Context, string, Settings) error
	Submit(context.Context, string, Input) (Receipt, error)
	Cancel(string) error
	Withdraw(context.Context, string, string) (Input, error)
	Wait(context.Context, string) (Outcome, error)
	CloseSession(string) error
	StopSession(string) error
	CancelAs(context.Context, string) error
	Subscribe(func(Event)) func()
	Emit(context.Context, Event)
}
type Store interface {
	Acquire(string) (Lease, error)
	List(string) ([]Session, error)
	Erase([]string) error
}
type Lease interface {
	Load() (Session, error)
	Save(Session) error
	Close() error
}
type Configuration interface {
	Settings(string) (Settings, error)
}
type Credentials interface {
	Get(context.Context, string) (string, error)
}
type WorkingEnvironment interface {
	StopsOnCrash() bool
	// Read returns an error matching fs.ErrNotExist for a missing file,
	// including when the environment is an external plugin or service.
	Read(context.Context, string, string) ([]byte, error)
	Write(context.Context, string, string, []byte) error
	Bash(context.Context, string, string, func(string)) (string, error)
	Close() error
}
type ToolSource interface {
	Tools(Session) []Tool
	Run(context.Context, Session, Call, func(string)) ToolResult
}
type Model struct {
	Wire                 json.RawMessage
	ID                   string
	Provider             string // catalog namespace used by shared host bindings
	Context, Output      int
	Thinking             []string
	Stateful, RunsTools  bool
	SafeToRepeatRequests bool // explicit promise, including Providers with outside effects
}
type Request struct {
	// ProviderTools is the host's separate in-process Provider-run allowance.
	// It is never part of a binding ModelRequest.
	ProviderTools []Tool
	Wire          json.RawMessage
	System        string
	Messages      []Message
	Tools         []Tool
	Thinking      string
	MaxOutput     int
}
type Message struct {
	Wire    json.RawMessage
	Role    string
	Content Content
	Result  *ToolResult
}
type Response struct {
	Wire    json.RawMessage
	Content Content
	Stop    string
	Usage   Usage
}
type ModelError struct{ Kind, Message string }

func (e *ModelError) Error() string { return e.Kind + ": " + e.Message }

type ModelAccess interface {
	Model() Model
	Generate(context.Context, Request, func(Part)) (Response, error)
}
type Provider interface {
	Catalog() []Model
	Access(string) (ModelAccess, error)
}
type Selection interface {
	Resolve(Session) (ModelAccess, error)
}
type RuntimeDeclaration struct {
	Durable, Steering, Parallel bool
	WaitingThroughRestart       bool
	NestedToolCalls             bool
}
type Runtime interface {
	Declaration() RuntimeDeclaration
	Run(context.Context, Turn) Outcome
}
type ExternalStart struct {
	Call  Call
	Tools []Tool
}
type TurnStarter struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type TurnStart struct {
	ContinuesTurn string
	StartedBy     TurnStarter
	Model         Model
	System        string
	Context       Content
	Calls         []Call
	Input         string
	Settings      Settings
	Tools         []Tool
}

// ResumedStep is the answered step supplied by a binding host. Committed is
// true for both an allowance and a refusal.
type ResumedStep struct {
	ID        string
	Response  Response
	Committed bool
	Refused   string
}

type Turn struct {
	ResumedStep        *ResumedStep
	StartedBy          TurnStarter
	Continuing         bool
	Interrupted        []Call // pending calls supplied by a binding host on resume
	ID, Session, Actor string
	Input              string
	Reopen             []Call
	Resume             bool
	CanRepeat          bool // working environment guarantees previous commands have stopped
	Settings           Settings
	System             string
	Context            Content
	Access             ModelAccess
	Tools              []Tool
	IO                 TurnPorts
}
type TurnPorts interface {
	Hook(context.Context, string, any) (any, error)
	Snapshot() (Session, error)
	Record(context.Context, Entry) (Entry, error)
	Emit(context.Context, Event)
	TakeSteering(context.Context) (bool, error)
	RunTool(context.Context, Call) ToolResult
}
type StepContext struct {
	// DeferredCompaction keeps the failure hook free of dispatch side effects.
	// Compact requests one auxiliary attempt during subsequent preparation.
	DeferredCompaction, Compact bool
	Turn                        Turn
	Step                        string
	Request                     Request
	Sources                     []string
	Usage                       Usage
}
type Failure struct {
	Context StepContext
	Err     error
	Retry   bool
}
type ToolCheck struct {
	InputChanged  bool
	Session, Turn string
	Open          bool
	Validate      func(Call) error
	Call          Call
	Definition    Tool
	Refused       string
}
type AfterTool struct {
	Call   Call
	Result ToolResult
}
type AfterStep struct {
	Step     string
	Response Response
	End      bool
}
type ResultCheck struct {
	Shape    json.RawMessage
	Value    json.RawMessage
	Result   Content
	Continue string
}
type InputEvent struct {
	Session string
	Input   Input
	Handled bool
	Result  string
}

// Forked lets plugins remap references in their own metadata after a history copy.
type Forked struct {
	Session Session
	Mapping map[string]string
}
type SessionPrepare struct {
	Session  Session
	Reopened bool
}

type BeforeTurn struct {
	Tools   []Tool
	Turn    string
	Input   Content
	Session Session
	System  string
	Context Content
}
