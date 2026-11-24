// Package questions implements recorded, keyed actor input, including late answers.
package questions

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type Manager struct {
	a       api.API
	mu      sync.Mutex
	changed chan struct{}
	present map[answerRoute]int
}

// A route can advertise presence without an answerable approval. An AG-UI
// approval route names the exact question whose unchanged view was delivered.
type answerRoute struct {
	session, actor, client, question string
	approval                         bool
}

type stored struct {
	Question                       api.Question
	ForwardSession, ForwardRequest string
}
type state struct {
	q        stored
	answer   *api.Answer
	closed   bool
	selected string
}
type relayKey struct{}
type relay struct{ Session, Request string }

func Plugin() api.Plugin {
	return api.Plugin{Name: "questions", Setup: func(a api.API) error {
		m := &Manager{a: a, changed: make(chan struct{}), present: map[answerRoute]int{}}
		if err := a.Provide("questions", m); err != nil {
			return err
		}
		if err := a.Provide("tools.questions", m); err != nil {
			return err
		}
		if err := a.RegisterCommand("requests", func(ctx context.Context, id string, _ []string) (string, error) {
			list, err := m.List(id)
			return string(api.JSON(list)), err
		}); err != nil {
			return err
		}
		if err := a.Handle("session.end", "", func(ctx context.Context, v any) (api.Decision, error) {
			id := v.(string)
			snap, e := a.Snapshot(id)
			if e == nil {
				for _, st := range states(snap) {
					if st.answer == nil && !st.closed && st.q.Question.ApprovalWait == "" {
						_ = m.decline(st.q.Question, "noLongerAnswerable")
					}
				}
			}
			return api.Decision{}, e
		}); err != nil {
			return err
		}
		if err := a.Handle("session.recoverQuestions", "", func(ctx context.Context, v any) (api.Decision, error) {
			return api.Decision{}, m.recoverSecrets(ctx, v.(api.Session))
		}); err != nil {
			return err
		}
		if err := a.Handle("session.ready", "", func(ctx context.Context, v any) (api.Decision, error) {
			s := v.(api.Session)
			m.resume(s.ID)
			return api.Decision{}, nil
		}); err != nil {
			return err
		}
		a.Subscribe(func(e api.Event) {
			if e.Kind == "turn.end" || e.Kind == "tool.end" {
				m.closeSettled(e.Session, e.Turn, e.Call)
			}
			if e.Kind == "turn.end" || (e.Kind == "history.added" && api.Decode[api.Entry](e.Data).Kind == "tool.open" && api.Decode[api.Entry](e.Data).Turn == "") {
				m.resume(e.Session)
			}
		})
		return nil
	}}
}
func (m *Manager) Connect(session, actor string) func() {
	return m.connect(answerRoute{session: session, actor: actor, approval: true})
}

// ConnectClient marks a client present; it does not make an approval deliverable.
func (m *Manager) ConnectClient(session, actor, client string) func() {
	return m.connect(answerRoute{session: session, actor: actor, client: client})
}

func (m *Manager) OfferApproval(session, actor, client, question string) func() {
	return m.connect(answerRoute{session: session, actor: actor, client: client, question: question, approval: true})
}

func (m *Manager) connect(route answerRoute) func() {
	m.mu.Lock()
	m.present[route]++
	m.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			m.present[route]--
			if m.present[route] == 0 {
				delete(m.present, route)
			}
			close(m.changed)
			m.changed = make(chan struct{})
			m.mu.Unlock()
		})
	}
}
func states(s api.Session) map[string]*state {
	out := map[string]*state{}
	for _, e := range s.Branch() {
		switch e.Kind {
		case "question.open":
			q := api.Decode[stored](e.Data)
			if q.Question.Session != s.ID {
				continue
			}
			q.Question.Deadline = questionDeadline(e.Time, q.Question.Wait)
			out[q.Question.ID] = &state{q: q}
		case "question.secret":
			if st := out[api.Decode[string](e.Data)]; st != nil {
				st.selected = e.Actor
			}
		case "question.answer":
			a := api.Decode[api.Answer](e.Data)
			if st := out[a.Request]; st != nil {
				st.answer = &a
			}
		case "question.closed":
			if st := out[api.Decode[string](e.Data)]; st != nil {
				st.closed = true
			}
		}
	}
	for _, e := range s.Branch() {
		if e.WasKind("tool.result") {
			for _, st := range out {
				if e.Call != "" && st.q.Question.Call == e.Call {
					st.closed = true
				}
			}
		}
	}
	return out
}
func (m *Manager) closeSettled(id, turn, call string) {
	s, err := m.a.Snapshot(id)
	if err != nil {
		return
	}
	for _, st := range states(s) {
		q := st.q.Question
		if st.answer == nil && st.closed && (call != "" && q.Call == call || turn != "" && q.Turn == turn) {
			_ = m.decline(q, "noLongerAnswerable")
		}
	}
}

func questionDeadline(at time.Time, wait time.Duration) *time.Time {
	if wait <= 0 {
		return nil
	}
	deadline := time.UnixMilli(at.UnixMilli() + max(1, wait.Milliseconds())).UTC()
	return &deadline
}

func expired(q api.Question) bool {
	return q.Deadline != nil && !q.Defer && !worktime.Now().Before(*q.Deadline)
}

func (m *Manager) valid(q api.Question, a api.Answer) bool {
	right := "answer"
	if q.Kind == "approval" {
		right = "approve"
	}
	if (len(q.Allowed) != 0 && !slices.Contains(q.Allowed, a.Actor)) || !m.a.Authorize(q.Session, a.Actor, right) {
		return false
	}
	for _, v := range a.Via {
		if !m.a.Authorize(v.Session, v.Actor, right) {
			return false
		}
	}
	return true
}
func (m *Manager) List(id string) ([]api.Question, error) {
	s, err := m.a.Snapshot(id)
	if err != nil {
		return nil, err
	}
	return m.Recorded(s), nil
}

// Recorded reads question state without opening the session or connecting a route.
func (m *Manager) Recorded(s api.Session) []api.Question {
	var out []api.Question
	waits := api.WaitingApprovals(s)
	for _, st := range states(s) {
		q := st.q.Question
		q.Answerable = !st.closed && st.answer == nil && st.selected == "" && !expired(q)
		if q.ApprovalWait != "" {
			w := waits[q.Call]
			q.Answerable = q.Answerable && w != nil && w.Listed && w.Pending.ID != "" && w.Terminal.ID == "" && w.Start.ID == ""
		}
		out = append(out, q)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
func signature(q api.Question) string {
	return fmt.Sprintf("%x", sha256.Sum256(api.JSON([]any{q.Call, q.Actor, q.Kind, q.Prompt, q.Options, q.Allowed, q.Credential, q.Details, q.Wait, q.Defer})))
}
func (m *Manager) Ask(ctx context.Context, q api.Question) (api.Answer, error) {
	q.ApprovalWait = "" // Only the Harness can mark a waiting gate.
	if q.Session == "" {
		e := api.Executing(ctx)
		q.Session, q.Turn, q.Call, q.Actor = e.Session, e.Turn, e.Call.ID, e.Call.Actor
	}
	s, err := m.a.Snapshot(q.Session)
	if err != nil {
		return api.Answer{}, err
	}
	if q.Actor == "" {
		q.Actor = s.Actor
	}
	if q.Kind != "approval" && q.Kind != "choice" && q.Kind != "text" && q.Kind != "link" && q.Kind != "secret" {
		return api.Answer{}, errors.New("invalid question kind")
	}
	if q.Kind == "approval" {
		q.Options = []string{"allow", "refuse"}
	}
	if q.Kind == "choice" && len(q.Options) == 0 {
		return api.Answer{}, errors.New("choice needs options")
	}
	if q.Kind == "secret" {
		v, e := m.a.Get("credentials")
		if e != nil || q.Credential == "" {
			return api.Answer{Declined: true, Reason: "secret destination unavailable"}, nil
		}
		if _, err := m.a.Get("provider." + q.Credential); err == nil {
			return api.Answer{Declined: true, Reason: "secret destination unavailable"}, nil
		}
		if _, staged := v.(api.StagedCredentials); !staged {
			return api.Answer{Declined: true, Reason: "credential store is read-only"}, nil
		}
		if d, ok := v.(api.SecretDestination); ok && !d.CanStore(q.Credential) {
			return api.Answer{Declined: true, Reason: "secret destination unavailable"}, nil
		}
	}
	right := "tools"
	if q.Turn == "" && q.Call == "" && q.Step != "" {
		right = "input"
	}
	if !api.ConnectionAllows(ctx, right) || !m.a.Authorize(q.Session, q.Actor, right) {
		return api.Answer{}, errors.New("asker lacks authority")
	}
	m.mu.Lock()
	s, err = m.a.Snapshot(q.Session)
	if err != nil {
		m.mu.Unlock()
		return api.Answer{}, err
	}
	n := api.NextQuestion(ctx, q.Call)
	if q.Key == "" {
		if q.Call == "" {
			q.Key = api.ID()
		} else {
			if n == 0 {
				n = 1
				for _, e := range s.Branch() {
					if e.WasKind("question.open") && e.Call == q.Call {
						n++
					}
				}
			}
			q.Key = fmt.Sprintf("call:%s:%d", q.Call, n)
		}
	}
	var found *state
	known := states(s)
	for _, e := range s.Branch() {
		if e.Kind == "question.open" {
			st := known[api.Decode[stored](e.Data).Question.ID]
			if st != nil && st.q.Question.Key == q.Key {
				found = st
			}
		}
	}
	if found != nil {
		if found.q.Question.ApprovalWait != "" || signature(found.q.Question) != signature(q) {
			m.mu.Unlock()
			return api.Answer{}, errors.New("question key reused with different request")
		}
		if found.answer != nil {
			a := *found.answer
			if a.Declined && a.Actor == "" {
				m.mu.Unlock()
				return api.Answer{}, &api.QuestionDeclined{Request: a.Request, Reason: a.Reason}
			}
			if m.valid(found.q.Question, a) {
				m.mu.Unlock()
				return a, nil
			}
		}
		if found.answer == nil && !found.closed {
			q.ID, q.Deadline = found.q.Question.ID, found.q.Question.Deadline
		} else {
			q.ID = ""
		}
	}
	if q.ID == "" {
		q.ID = api.ID()
		if step := api.Executing(ctx).Call.Step; step != "" {
			q.Step = step
		}
		q.Answerable = true
		st := stored{Question: q}
		if r, ok := ctx.Value(relayKey{}).(relay); ok {
			st.ForwardSession, st.ForwardRequest = r.Session, r.Request
		}
		var copies []string
		for _, entry := range s.Branch() {
			if q.Call != "" && entry.Kind == "tool.call" && entry.Call == q.Call {
				copies = append(copies, entry.ID)
			}
		}
		if st.ForwardRequest != "" {
			copies = append(copies, st.ForwardRequest)
		}
		entry, err := m.a.Record(ctx, q.Session, api.Entry{Copies: copies, ID: q.ID, Kind: "question.open", Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: q.Actor, Data: api.JSON(st)})
		if err != nil {
			m.mu.Unlock()
			return api.Answer{}, err
		}
		q.Deadline = questionDeadline(entry.Time, q.Wait)
	}
	m.mu.Unlock()
	questionTrace(ctx, q, "")
	m.a.Emit(ctx, api.Event{Kind: "question.open", Session: q.Session, Turn: q.Turn, Call: q.Call, Data: api.JSON(q)})
	if s.Parent != "" {
		parent, e := m.a.Snapshot(s.Parent)
		if e != nil {
			return api.Answer{}, e
		}
		mirror := q
		mirror.ID = ""
		mirror.Session = s.Parent
		mirror.Actor = parent.Actor
		mirror.Turn = ""
		mirror.Call = ""
		mirror.Allowed = []string{parent.Actor}
		mirror.Key = "relay:" + q.Session + ":" + q.ID
		mirror.Path = append([]string{q.Session}, q.Path...)
		_, e = m.Ask(context.WithValue(ctx, relayKey{}, relay{q.Session, q.ID}), mirror)
		if e != nil {
			return api.Answer{}, e
		}
	}
	var deadline chan struct{}
	if q.Deadline != nil {
		deadline = make(chan struct{})
		timer := worktime.At(*q.Deadline, func() { close(deadline) })
		defer timer.Stop()
	}
	for {
		m.mu.Lock()
		s, e := m.a.Snapshot(q.Session)
		if e != nil {
			m.mu.Unlock()
			return api.Answer{}, e
		}
		st := states(s)[q.ID]
		ch := m.changed
		if st == nil || st.closed {
			m.mu.Unlock()
			return api.Answer{}, errors.New("question no longer answerable")
		}
		if st.answer != nil {
			a := *st.answer
			valid := m.valid(q, a)
			m.mu.Unlock()
			if a.Declined && a.Actor == "" {
				return api.Answer{}, &api.QuestionDeclined{Request: a.Request, Reason: a.Reason}
			}
			if !valid {
				return api.Answer{}, errors.New("answer authority revoked")
			}
			return a, nil
		}
		present, eligible := false, false
		if q.Kind == "approval" {
			for who := range s.Actors {
				if m.approvalRouteLocked(q, who) && m.valid(q, api.Answer{Actor: who}) {
					present = true
					break
				}
			}
			if s.Actors == nil {
				present = m.approvalRouteLocked(q, s.Actor) && m.valid(q, api.Answer{Actor: s.Actor})
			}
		}
		m.mu.Unlock()
		if q.Kind != "approval" && s.Parent == "" {
			for who := range s.Actors {
				if m.valid(q, api.Answer{Actor: who}) {
					eligible = true
					break
				}
			}
			if s.Actors == nil {
				eligible = m.valid(q, api.Answer{Actor: s.Actor})
			}
			if !eligible {
				return api.Answer{}, m.decline(q, "noLongerAnswerable")
			}
		}
		if q.Kind == "approval" && s.Parent == "" && !present {
			return api.Answer{}, m.decline(q, "refused")
		}
		if q.Pause {
			return api.Answer{}, api.ErrQuestionOpen
		}
		select {
		case <-ctx.Done():
			if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
				_ = m.decline(q, "cancelled")
			}
			return api.Answer{}, ctx.Err()
		case <-ch:
		case <-deadline:
			if q.Defer {
				return api.Answer{}, api.ErrQuestionOpen
			}
			return api.Answer{}, m.decline(q, "timeLimit")
		}
	}
}
func (m *Manager) RefuseUndeliverableApproval(q api.Question) {
	if q.Kind == "approval" && q.ApprovalWait == "" {
		_ = m.decline(q, "refused")
	}
}

// DeclineUnanswered settles a question an embedded host cannot deliver.
func (m *Manager) DeclineUnanswered(q api.Question, reason string) {
	_ = m.decline(q, reason)
}

// CloseCall makes any remaining questions for a terminal nested call unanswerable.
func (m *Manager) CloseCall(session, call string) error {
	list, err := m.List(session)
	if err != nil {
		return err
	}
	for _, q := range list {
		if q.Call == call && q.Answerable {
			err = m.decline(q, "noLongerAnswerable")
			var declined *api.QuestionDeclined
			if err != nil && !errors.As(err, &declined) {
				return err
			}
		}
	}
	return nil
}
func (m *Manager) decline(q api.Question, reason string) error {
	m.mu.Lock()
	s, err := m.a.Snapshot(q.Session)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	settled := false
	if st := states(s)[q.ID]; st != nil && st.answer == nil && st.selected == "" && st.q.Question.ApprovalWait == "" {
		_, err = m.a.Record(context.Background(), q.Session, api.Entry{Kind: "question.answer", Turn: q.Turn, Step: st.q.Question.Step, Call: q.Call, Actor: q.Actor, Copies: []string{q.ID}, Data: api.JSON(api.Answer{Request: q.ID, Declined: true, Reason: reason})})
		settled = err == nil
		if err == nil && q.Kind == "secret" {
			if store := m.secretStore(); store != nil {
				err = store.Discard(context.Background(), q.Session, q.ID)
			}
		}
		close(m.changed)
		m.changed = make(chan struct{})
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if settled {
		m.emitClosure(context.Background(), q, reason)
	}
	return &api.QuestionDeclined{Request: q.ID, Reason: reason}
}

type skipQuestionTrace struct{}

func questionTrace(ctx context.Context, q api.Question, disposition string) {
	if ctx.Value(skipQuestionTrace{}) != nil {
		return
	}
	attrs := []attribute.KeyValue{telemetry.String("modular_agent.question.id", q.ID), telemetry.String("modular_agent.question.kind", telemetry.Name(q.Kind))}
	name := "modular_agent.question.open"
	if disposition != "" {
		name = "modular_agent.question.close"
		switch disposition {
		case "answered", "stored", "declined", "noLongerAnswerable", "timeLimit", "cancelled", "turnEnded", "restart":
		default:
			disposition = "declined"
		}
		attrs = append(attrs, telemetry.String("modular_agent.question.disposition", disposition))
	}
	if !trace.SpanFromContext(ctx).IsRecording() {
		var span trace.Span
		ctx, span = telemetry.Start(telemetry.Step(telemetry.Session(ctx, q.Session), q.Step), "modular_agent.question.answer")
		defer span.End()
	}
	telemetry.Event(ctx, name, attrs...)
}

func (m *Manager) emitClosure(ctx context.Context, q api.Question, reason string) {
	questionTrace(ctx, q, reason)
	data := api.JSON(map[string]any{"questionId": q.ID, "reason": reason})
	if reason == "noLongerAnswerable" {
		m.a.Emit(ctx, api.Event{Kind: "question.unanswerable", Session: q.Session, Turn: q.Turn, Step: q.Step, Call: q.Call, Data: data})
	}
	m.a.Emit(ctx, api.Event{Kind: "question.closed", Session: q.Session, Turn: q.Turn, Step: q.Step, Call: q.Call, Data: data})
}
func (m *Manager) Answer(ctx context.Context, id string, a api.Answer) error {
	a.Actor = api.Acting(ctx)
	a.Via = nil
	return m.accept(ctx, id, a, false, "")
}

// AnswerFor retains the host's own authority as well as the answering actor's.
func (m *Manager) AnswerFor(ctx context.Context, id, actor string, a api.Answer) error {
	a.Actor = actor
	a.Via = []api.ActorRef{{Session: id, Actor: api.Acting(ctx)}}
	return m.accept(ctx, id, a, false, "")
}

func (m *Manager) Present(id, actor string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for r := range m.present {
		if r.session == id && r.actor == actor {
			return true
		}
	}
	return false
}

func (m *Manager) approvalRouteLocked(q api.Question, actor string) bool {
	for r := range m.present {
		if r.session == q.Session && r.actor == actor && r.approval && (r.question == "" || r.question == q.ID) {
			return true
		}
	}
	return false
}

// AnswerOnClient checks the live approval route under the answer commit lock.
func (m *Manager) AnswerOnClient(ctx context.Context, id, client string, a api.Answer) error {
	a.Actor, a.Via = api.Acting(ctx), nil
	return m.accept(ctx, id, a, false, client)
}

func (m *Manager) accept(ctx context.Context, id string, a api.Answer, sanitized bool, client string) error {
	// Leave a refused answer open for a bounded replacement. Even the worst
	// JSON escaping of this value fits the reserved closing record.
	if len(a.Value) > 256<<10 {
		return api.ErrResultTooLarge
	}
	m.mu.Lock()
	s, err := m.a.Snapshot(id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	st := states(s)[a.Request]
	if st == nil || st.closed || st.answer != nil || st.selected != "" {
		m.mu.Unlock()
		return api.ErrQuestionNotFound
	}
	q := st.q.Question
	if q.ApprovalWait != "" {
		m.mu.Unlock()
		return api.ErrAnswerAuthority
	}
	if expired(q) {
		m.mu.Unlock()
		_ = m.decline(q, "timeLimit")
		return api.ErrQuestionNotFound
	}
	if !m.valid(q, a) || client != "" && q.Kind == "approval" && m.present[answerRoute{id, a.Actor, client, q.ID, true}] == 0 {
		m.mu.Unlock()
		return api.ErrAnswerAuthority
	}
	// ACP's reject option is a decline, not a shared approval value.
	if q.Kind == "approval" && a.Value == "refuse" {
		a.Declined = true
	}
	if !a.Declined && (q.Kind == "choice" || q.Kind == "approval") && !slices.Contains(q.Options, a.Value) {
		m.mu.Unlock()
		return api.ErrInvalidAnswer
	}
	if q.Kind == "secret" && !a.Declined && !sanitized {
		v, e := m.a.Get("credentials")
		if e != nil {
			m.mu.Unlock()
			return errors.New("credential store unavailable")
		}
		if store, ok := v.(api.StagedCredentials); ok {
			if e := m.selectSecret(ctx, store, q, a); e != nil {
				m.mu.Unlock()
				if errors.Is(e, errDeadline) {
					_ = m.decline(q, "timeLimit")
					return api.ErrQuestionNotFound
				}
				return e
			}
			decision, e := m.activateSecret(ctx, store, q, a.Actor)
			if e != nil {
				m.mu.Unlock()
				return e
			}
			if decision == api.SecretSuperseded {
				a.Declined, a.Reason = true, "superseded"
			} else {
				a.Value, a.Stored = q.Credential, q.Credential
			}
		} else {
			m.mu.Unlock()
			return errors.New("credential store read-only")
		}
	}
	if a.Declined {
		a.Value = ""
	}
	_, err = m.a.Record(ctx, id, api.Entry{Kind: "question.answer", Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: a.Actor, Copies: []string{q.ID}, Data: api.JSON(a)})
	if err == nil {
		if q.Kind == "secret" && a.Declined && st.selected == "" {
			if store := m.secretStore(); store != nil {
				err = store.Discard(ctx, id, q.ID)
			}
		}
		close(m.changed)
		m.changed = make(chan struct{})
	}
	forward := st.q
	m.mu.Unlock()
	if err != nil {
		return err
	}
	m.a.Emit(ctx, api.Event{Kind: "question.answered", Session: id, Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: a.Actor, Data: api.JSON(a)})
	disposition := "answered"
	if a.Declined {
		disposition = "declined"
	} else if q.Kind == "secret" {
		disposition = "stored"
	}
	questionTrace(ctx, q, disposition)
	m.emitClosure(context.WithValue(ctx, skipQuestionTrace{}, true), q, a.Reason)
	if forward.ForwardSession != "" {
		child, e := m.a.Snapshot(forward.ForwardSession)
		if e != nil {
			return e
		}
		via := append(append([]api.ActorRef(nil), a.Via...), api.ActorRef{Session: id, Actor: a.Actor})
		e = m.accept(ctx, child.ID, api.Answer{Request: forward.ForwardRequest, Actor: child.Actor, Value: a.Value, Declined: a.Declined, Via: via}, true, "")
		if e != nil {
			return e
		}
	}
	m.resume(id)
	return nil
}
func (m *Manager) resume(id string) {
	if scheduler, ok := m.a.(interface{ ContinueInterfaceWork(string) }); ok {
		scheduler.ContinueInterfaceWork(id)
	}
	s, err := m.a.Snapshot(id)
	if err != nil {
		return
	}
	pending := api.OpenCalls(s)
	handoffs := api.InterfaceHandoffs(s)
	waits := api.WaitingApprovals(s)
	sts := states(s)
	for _, e := range s.Branch() {
		out := api.Outcome{}
		if e.Kind == "turn.end" {
			out = api.Decode[api.Outcome](e.Data)
		} else if e.Kind == "tool.open" && e.Turn == "" {
			for _, c := range pending {
				if c.ID == e.Call {
					out.Open = []api.Call{c}
				}
			}
		} else {
			continue
		}
		if len(out.Open) == 0 || slices.ContainsFunc(out.Open, func(c api.Call) bool { return handoffs[c.ID].ID != "" || waits[c.ID] != nil }) {
			continue
		}
		var ready []api.Call
		all := true
		for _, c := range out.Open {
			exists := false
			for _, p := range pending {
				if p.ID == c.ID {
					c = p
					exists = true
				}
			}
			if !exists {
				continue
			}
			has, answered := false, true
			for _, st := range sts {
				if st.q.Question.Call == c.ID && !st.closed {
					has = true
					if st.answer == nil {
						answered = false
					}
				}
			}
			if !has || !answered {
				all = false
			}
			ready = append(ready, c)
		}
		if !all || len(ready) == 0 {
			continue
		}
		var ids []string
		for _, c := range ready {
			ids = append(ids, c.ID)
		}
		sort.Strings(ids)
		lastAnswer := ""
		for _, e := range s.Branch() {
			if e.Kind == "question.answer" && slices.Contains(ids, e.Call) {
				lastAnswer = api.Decode[api.Answer](e.Data).Request
			}
		}
		_, _ = m.a.Submit(context.Background(), id, api.Input{Key: "late:" + strings.Join(ids, ":"), Answer: lastAnswer, Actor: ready[0].Actor, When: "after", Calls: ready})
	}
}
