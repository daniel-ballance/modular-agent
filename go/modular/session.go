package modular

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type Session struct {
	approvalInstance string
	agent            *Agent
	id               string
	actor            string
}

func (s *Session) ID() string { return s.id }
func (s *Session) ctx(ctx context.Context) context.Context {
	ctx = api.AsActor(ctx, s.actorID())
	if s.actorID() != localActor {
		return api.WithActingVia(ctx, localActor)
	}
	return api.WithActingVia(ctx, "")
}

type Disposition string

const (
	Turn       Disposition = "turn"
	Handled    Disposition = "handled"
	HandedBack Disposition = "handedBack"
)

type Outcome struct {
	Kind  string `json:"kind"`
	Error string `json:"error,omitempty"`
	Limit string `json:"limit,omitempty"`
}
type PromptResult struct {
	InputID       string          `json:"inputId"`
	Disposition   Disposition     `json:"disposition"`
	Outcome       *Outcome        `json:"outcome,omitempty"`
	Text          string          `json:"text,omitempty"`
	Value         json.RawMessage `json:"value,omitempty"`
	TurnID        string          `json:"turnId,omitempty"`
	OpenToolCalls []string        `json:"openToolCalls,omitempty"`
	Usage         *Usage          `json:"usage,omitempty"`
	results       []ToolResult
}

func (r PromptResult) ToolResults() []ToolResult { return slices.Clone(r.results) }

type PromptOption func(*promptOptions)
type promptOptions struct {
	key    string
	schema json.RawMessage
}

// WithResult requests a final JSON value checked against a JSON Schema.
func WithResult(schema any) PromptOption {
	return func(p *promptOptions) {
		p.schema, _ = json.Marshal(schema)
		if len(p.schema) == 0 {
			p.schema = json.RawMessage("null")
		}
	}
}

func WithInputKey(key string) PromptOption { return func(p *promptOptions) { p.key = key } }

type Timing string

const (
	Now     Timing = "now"
	Steer   Timing = "steer"
	After   Timing = "after"
	Propose Timing = "propose"
)

type InputReceipt struct {
	InputID     string `json:"inputId"`
	Disposition string `json:"disposition"`
	Duplicate   bool   `json:"duplicate,omitempty"`
	Erased      bool   `json:"erased,omitempty"`
}

func (s *Session) Send(ctx context.Context, input any, timing Timing, opts ...PromptOption) (InputReceipt, error) {
	if err := ctx.Err(); err != nil {
		return InputReceipt{}, appError(err, CancelledCode)
	}
	if timing != Now && timing != Steer && timing != After && timing != Propose {
		return InputReceipt{}, &Error{Code: InvalidParams, Message: "invalid input timing"}
	}
	if timing == Propose && !s.agent.severalActors {
		return InputReceipt{}, &Error{Code: NotSupported, Message: "several actors disabled"}
	}
	var content api.Content
	switch v := input.(type) {
	case string:
		content = api.Text(v)
	case Content:
		content = portable.ReadContent(v)
	default:
		return InputReceipt{}, &Error{Code: InvalidParams, Message: "input must be text or Content"}
	}
	var p promptOptions
	for _, opt := range opts {
		opt(&p)
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return InputReceipt{}, appError(err, NotOpen)
	}
	if len(p.schema) != 0 {
		if timing != Now {
			return InputReceipt{}, &Error{Code: InvalidParams, Message: "structured result requires timing now"}
		}
		if _, err := api.ResolveSchema(p.schema); err != nil {
			return InputReceipt{}, appError(err, InvalidParams)
		}
	}
	var via string
	if s.actorID() != localActor {
		via = localActor
	}
	r, err := s.agent.a.Submit(s.ctx(ctx), s.id, api.Input{Actor: s.actorID(), ViaActor: via, When: string(timing), Key: p.key, Content: content, ResultSchema: p.schema})
	if errors.Is(err, api.ErrAuthority) {
		return InputReceipt{}, appError(err, Forbidden)
	}
	if errors.Is(err, api.ErrUnknownModel) {
		return InputReceipt{}, appError(err, InvalidRequest)
	}
	if errors.Is(err, api.ErrInputConflict) {
		return InputReceipt{}, appError(err, Conflict)
	}
	receipt := InputReceipt{InputID: r.ID, Disposition: r.When, Duplicate: r.Duplicate, Erased: r.Erased}
	if err == nil && !r.Duplicate && r.When != "command" {
		s.emitOperation(ctx, "input.accepted", receipt)
	}
	return receipt, appError(err, Busy)
}
func (s *Session) Prompt(ctx context.Context, input any, opts ...PromptOption) (PromptResult, error) {
	return s.prompt(ctx, input, nil, opts)
}
func (s *Session) PromptStream(ctx context.Context, input any, opts ...PromptOption) iter.Seq2[Event, error] {
	return func(yield func(Event, error) bool) {
		_, err := s.prompt(ctx, input, yield, opts)
		if err != nil {
			yield(nil, err)
		}
	}
}
func (s *Session) prompt(ctx context.Context, input any, yield func(Event, error) bool, opts []PromptOption) (PromptResult, error) {
	type interruptionSource interface {
		SessionInterruption(string) (<-chan struct{}, <-chan struct{}, error)
	}
	interrupted, emitted, err := s.agent.a.(interruptionSource).SessionInterruption(s.id)
	if err != nil {
		return PromptResult{}, appError(err, NotOpen)
	}
	interruption := make(chan api.Event, 1)
	eventBuf := make(chan api.BufferedEvent, 256)
	var outputMu sync.Mutex
	outputStopped := false
	overflow := make(chan struct{}, 1)
	wake := make(chan struct{}, 1)
	subscribe := s.agent.a.(interface {
		SubscribeOutput(func(api.Event) string, func(api.Event)) func()
	})
	stop := subscribe.SubscribeOutput(func(api.Event) string { return s.actorID() }, func(e api.Event) {
		if e.Session != s.id {
			return
		}
		if e.Kind == api.SessionInterrupted {
			select {
			case interruption <- e:
			default:
			}
			return
		}
		if yield == nil {
			select {
			case wake <- struct{}{}:
			default:
			}
			return
		}
		outputMu.Lock()
		defer outputMu.Unlock()
		if outputStopped {
			return
		}
		if event, ok := api.BufferEvent(s.agent.a, e); ok {
			select {
			case eventBuf <- event:
				return
			default:
				event.Release()
			}
		}
		select {
		case overflow <- struct{}{}:
		default:
		}
	})
	defer func() {
		stop()
		outputMu.Lock()
		defer outputMu.Unlock()
		outputStopped = true
		close(eventBuf)
		for event := range eventBuf {
			event.Release()
		}
	}()
	r, err := s.Send(ctx, input, Now, opts...)
	if err != nil {
		return PromptResult{}, err
	}
	if r.Disposition == "command" {
		return PromptResult{InputID: r.InputID, Disposition: Handled}, nil
	}
	if r.Erased {
		return PromptResult{InputID: r.InputID, Disposition: HandedBack}, nil
	}
	// Some admission/settlement records in the base do not yet have a live event.
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	lastDelivered := ""
	lost := func() (PromptResult, error) {
		return PromptResult{}, streamLost("prompt stream fell behind", lastDelivered)
	}
	terminal := interrupted
	if yield != nil {
		terminal = emitted // Give the gated live event a chance to reach the stream first.
	}
	for {
		select {
		case <-overflow:
			return lost()
		default:
		}
		if yield == nil || r.Duplicate {
			snap, err := s.view(ctx)
			if err != nil {
				return PromptResult{}, err
			}
			if result := resultFor(snap, r.InputID); result != nil {
				if yield != nil && result.Outcome != nil {
					yield(EndEvent{EventHeader: EventHeader{Type: "turnEnded", SessionID: s.id, TurnID: result.TurnID}, Outcome: *result.Outcome, Result: TurnResult{Text: result.Text, Value: result.Value, OpenToolCalls: append([]string{}, result.OpenToolCalls...)}}, nil)
				}
				return *result, nil
			}
		}
		select {
		case <-ctx.Done():
			return PromptResult{}, appError(ctx.Err(), CancelledCode)
		case <-overflow:
			return lost()
		case raw := <-interruption:
			if yield != nil && !yield(sdkEvent(raw), nil) {
				return PromptResult{}, nil
			}
			return PromptResult{}, appError(api.ErrSessionLost, Lost)
		case <-terminal:
			if yield != nil {
				select {
				case raw := <-interruption:
					if !yield(sdkEvent(raw), nil) {
						return PromptResult{}, nil
					}
				default:
				}
			}
			return PromptResult{}, appError(api.ErrSessionLost, Lost)
		case <-wake:
		case <-tick.C:
			if yield != nil {
				snap, err := s.view(ctx)
				if err != nil {
					return PromptResult{}, err
				}
				if result := resultFor(snap, r.InputID); result != nil && result.Disposition != Turn {
					return *result, nil
				}
			}
		case event := <-eventBuf:
			raw := event.Event
			event.Release()
			if raw.Turn == "" {
				continue
			}
			snap, err := s.view(ctx)
			if err != nil {
				return PromptResult{}, err
			}
			if turnFor(snap, r.InputID) != raw.Turn {
				continue
			}
			epoch, err := s.agent.a.(interface{ ErasureEpoch(string) (int, error) }).ErasureEpoch(s.id)
			if err != nil || epoch != raw.ErasureEpoch {
				return PromptResult{}, appError(api.ErrErasureUnavailable, Unavailable)
			}
			e := sdkEvent(raw)
			if e != nil {
				if !yield(e, nil) {
					return PromptResult{}, nil
				}
				if raw.Kind == "history.added" {
					if id := api.Decode[api.Entry](raw.Data).ID; id != "" {
						lastDelivered = id
					}
				}
			}
			if raw.Kind == "turn.end" {
				if result := resultFor(snap, r.InputID); result != nil {
					return *result, nil
				}
			}
		}
	}
}
func (s *Session) view(ctx context.Context) (api.Session, error) {
	if err := ctx.Err(); err != nil {
		return api.Session{}, appError(err, CancelledCode)
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return api.Session{}, appError(err, NotOpen)
	}
	if err := s.require(ctx, "watch"); err != nil {
		return api.Session{}, err
	}
	v, err := s.agent.a.View(s.ctx(ctx), s.id)
	if errors.Is(err, api.ErrOutputWithheld) {
		return api.Session{}, appError(err, Withheld)
	}
	return v, appError(err, Forbidden)
}
func turnFor(s api.Session, input string) string {
	for _, e := range s.Entries {
		if e.Kind == "input" && e.InputID() == input {
			return e.Turn
		}
		if e.Kind == "turn.start" && api.Decode[api.TurnStart](e.Data).Input == input {
			return e.Turn
		}
	}
	return ""
}
func resultFor(s api.Session, input string) *PromptResult {
	turn := turnFor(s, input)
	for _, e := range s.Entries {
		if turn != "" && e.Kind == "turn.end" && e.Turn == turn {
			return buildResult(s, e, input)
		}
		if turn == "" && (e.Kind == "input.returned" || e.Kind == "input.withdrawn") && slices.Contains(e.HandedBackIDs(), input) {
			return &PromptResult{InputID: input, Disposition: HandedBack}
		}
	}
	return nil
}
func outcome(out api.Outcome) *Outcome {
	o := &Outcome{Kind: out.Status}
	if out.Status == "failed" {
		o.Error = out.Error
	}
	if out.Status == "limit" {
		o.Limit = strings.TrimSuffix(out.Error, " limit")
		if o.Limit == "step" {
			o.Limit = "steps"
		}
	}
	return o
}
func buildResult(s api.Session, end api.Entry, input string) *PromptResult {
	out := api.Decode[api.Outcome](end.Data)
	r := &PromptResult{InputID: input, Disposition: Turn, TurnID: end.Turn, Text: out.Result.Text(), Value: out.Value, Outcome: outcome(out), Usage: &Usage{Input: out.Usage.Input, Output: out.Usage.Output, CacheRead: out.Usage.Cached, CacheWrite: out.Usage.CacheWrite, Cost: out.Usage.Cost}}
	for _, c := range out.Open {
		r.OpenToolCalls = append(r.OpenToolCalls, c.ID)
	}
	var order []string
	names := map[string]string{}
	results := map[string]ToolResult{}
	for _, e := range s.Entries {
		if e.Turn != end.Turn {
			continue
		}
		switch e.Kind {
		case "turn.start":
			if r.InputID == "" {
				r.InputID = api.Decode[api.TurnStart](e.Data).Input
			}
		case "model":
			// The recorded assistant response provides both attribution and
			// call order, even when calls are dispatched in parallel.
			for _, part := range e.Content {
				if c := part.Call; c != nil && c.ParentCall == "" {
					if _, ok := names[c.ID]; !ok {
						order = append(order, c.ID)
					}
					names[c.ID] = c.Name
				}
			}
		case "tool.result":
			result := api.Decode[api.ToolResult](e.Data)
			result.Content = e.Content
			var v ToolResult
			_ = decodeInto(portable.Result(result), &v)
			if v.CallID == "" {
				v.CallID = e.Call
			}
			v.Name = result.Name
			results[e.Call] = v
		}
	}
	for _, id := range order {
		if v, ok := results[id]; ok {
			if v.Name == "" {
				v.Name = names[id]
			}
			r.results = append(r.results, v)
		}
	}
	return r
}
func (s *Session) LastTurn(ctx context.Context) (*PromptResult, error) {
	snap, err := s.view(ctx)
	if err != nil {
		return nil, err
	}
	for _, e := range slices.Backward(snap.Entries) {
		if e.Kind == "turn.end" {
			return buildResult(snap, e, ""), nil
		}
	}
	return nil, nil
}
func (s *Session) History(ctx context.Context) ([]HistoryEntry, error) {
	snap, err := s.view(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]HistoryEntry, 0, len(snap.Entries))
	for _, e := range snap.Entries {
		out = append(out, portable.Entry(e))
	}
	return out, nil
}

// Busy reports whether the session has active work.
func (s *Session) Busy() (bool, error) {
	if err := s.require(context.Background(), "watch"); err != nil {
		return false, err
	}
	busy, err := s.agent.h.Busy(s.id)
	return busy, appError(err, NotOpen)
}

// WaitIdle waits until the session has settled its admitted work.
func (s *Session) WaitIdle(ctx context.Context) error {
	if err := s.require(ctx, "watch"); err != nil {
		return err
	}
	_, err := s.agent.a.Wait(s.ctx(ctx), s.id)
	return appError(err, Lost)
}

func (s *Session) Cancel(ctx context.Context) ([]InputReceipt, error) {
	ctx = s.ctx(ctx)
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if err := s.require(ctx, "cancel"); err != nil {
		return nil, err
	}
	busy, err := s.agent.h.Busy(s.id)
	if err != nil {
		return nil, appError(err, NotOpen)
	}
	if !busy && !s.agent.h.SupportsInterfaceTools() && !s.agent.h.SupportsWaitingApprovals() {
		return nil, nil
	}
	if err := s.agent.a.CancelAs(ctx, s.id); err != nil {
		return nil, appError(err, Forbidden)
	}
	if !busy {
		return nil, nil
	}
	out, err := s.agent.a.Wait(ctx, s.id)
	if err != nil {
		return nil, appError(err, Lost)
	}
	var returned []InputReceipt
	for _, in := range out.Returned {
		returned = append(returned, InputReceipt{InputID: in.ID, Disposition: string(HandedBack)})
	}
	return returned, nil
}
func (s *Session) Settings(ctx context.Context) (Settings, error) {
	snap, err := s.view(ctx)
	if err != nil {
		return nil, err
	}
	return sessionSettings(snap.Settings), nil
}

func sessionSettings(b api.Settings) Settings {
	out := Settings{"reasoning": b.Thinking, "approval": api.ApprovalWire(b.Approval), "maxSteps": b.MaxSteps, "maxOutput": b.MaxOutput}
	if b.ApprovalWait != "" {
		out["approvalWait"] = b.ApprovalWait
	}
	if b.ModelTools == nil {
		out["modelTools"] = nil
	} else {
		out["modelTools"] = slices.Clone(*b.ModelTools)
	}
	if provider, id, ok := strings.Cut(b.Model, "/"); ok {
		out["model"] = ModelRef{Provider: provider, ID: id}
	}
	return out
}
func (s *Session) SetSetting(ctx context.Context, key string, value any) error {
	actual, err := s.setSetting(ctx, key, value)
	if err == nil {
		s.emitOperation(ctx, "setting.changed", SettingData{Key: key, Value: actual})
	}
	return err
}

func (s *Session) setSetting(ctx context.Context, key string, value any) (_ any, err error) {
	s.agent.settingsMu.Lock()
	defer s.agent.settingsMu.Unlock()
	ctx = s.ctx(ctx)
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	snap, err := s.agent.a.Snapshot(s.id)
	if err != nil {
		return nil, appError(err, NotOpen)
	}
	if err := s.require(ctx, "settings"); err != nil {
		return nil, err
	}
	if key == "approvalWait" {
		if !s.agent.h.SupportsWaitingApprovals() {
			return nil, &Error{Code: NotSupported, Message: "waiting approvals are not supported"}
		}
		if snap.Settings.ApprovalWait == "" {
			snap.Settings.ApprovalWait = "live"
		}
	}
	if err = applySetting(&snap.Settings, key, value); err != nil {
		return nil, err
	}
	if key == "model" && !s.agent.offersModel(snap.Settings.Model) {
		return nil, &Error{Code: InvalidRequest, Message: "model is not offered"}
	}
	return sessionSettings(snap.Settings)[key], appError(s.agent.a.SetSettings(ctx, s.id, snap.Settings), Busy)
}
func (s *Session) Fork(ctx context.Context, entryID ...string) (*Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if len(entryID) > 1 {
		return nil, &Error{Code: InvalidParams, Message: "at most one entry id"}
	}
	target := ""
	if len(entryID) == 1 {
		target = entryID[0]
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return nil, appError(err, NotOpen)
	}
	if err := s.require(ctx, "settings"); err != nil {
		return nil, err
	}
	id, err := s.agent.a.Fork(s.ctx(ctx), s.id, target)
	if err != nil {
		return nil, appError(err, Busy)
	}
	return &Session{agent: s.agent, id: id, actor: s.actor, approvalInstance: api.ID()}, nil
}
func (s *Session) OnQuestion(ctx context.Context, h QuestionHandler) error {
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return appError(err, NotOpen)
	}
	if s.actorID() != localActor {
		return &Error{Code: NotSupported, Message: "only the local actor has a question handler"}
	}
	s.agent.q.attach(s.id, h)
	return nil
}
func (s *Session) Commands(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return nil, appError(err, NotOpen)
	}
	if err := s.require(ctx, "watch"); err != nil {
		return nil, err
	}
	return s.agent.a.Commands(), nil
}
func (s *Session) RunCommand(ctx context.Context, line string) (string, error) {
	commands, err := s.Commands(ctx)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(strings.TrimPrefix(line, "/"))
	if len(fields) == 0 {
		return "", &Error{Code: InvalidParams, Message: "command is empty"}
	}
	if !slices.Contains(commands, fields[0]) {
		return "", &Error{Code: NotFound, Message: "command is not registered"}
	}
	text, err := s.agent.a.Command(s.ctx(ctx), s.id, line)
	return text, appError(err, Lost)
}

func (s *Session) Close(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	v, ok := s.agent.a.(interface{ CloseAs(string, string) error })
	if ok {
		if delegated, ok := s.agent.a.(interface {
			CloseFor(context.Context, string) error
		}); ok {
			err := delegated.CloseFor(s.ctx(ctx), s.id)
			if errors.Is(err, api.ErrCloseForbidden) {
				return appError(err, Forbidden)
			}
			return appError(err, NotOpen)
		}
		return appError(v.CloseAs(s.id, s.actorID()), NotOpen)
	}
	return appError(s.agent.a.CloseSession(s.id), NotOpen)
}
