package modular

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
)

// Actor is a session member whose rights can be narrowed by session and tenant policy.
type Actor = api.Actor

// Tenant defines a deployment rights ceiling and optional reported-token budget.
type Tenant = harness.TenantConfig

type SessionOptions struct {
	Settings Settings
	Tenant   string
	Actors   []Actor
}

func WithSeveralActors(enabled bool) Option {
	return func(o *options) error { o.severalActors = enabled; return nil }
}
func WithSessionLimits(enabled bool) Option {
	return func(o *options) error { o.sessionLimits = enabled; return nil }
}
func WithTenants(tenants map[string]Tenant) Option {
	return func(o *options) error {
		o.tenants = maps.Clone(tenants)
		for name, tenant := range o.tenants {
			if name == "" || tenant.Rights == nil || tenant.Tokens != nil && *tenant.Tokens < 0 {
				return fmt.Errorf("invalid tenant configuration for %q", name)
			}
			tenant.Rights = slices.Clone(tenant.Rights)
			if tenant.Tokens != nil {
				tokens := *tenant.Tokens
				tenant.Tokens = &tokens
			}
			o.tenants[name] = tenant
		}
		return nil
	}
}

func validActor(actor Actor) error {
	if actor.ID == "" || actor.Kind == "" {
		return &Error{Code: InvalidParams, Message: "actor id and kind are required"}
	}
	return nil
}
func copyActor(a Actor) Actor { a.Rights = slices.Clone(a.Rights); return a }

func (s *Session) actorID() string {
	if s.actor == "" {
		return localActor
	}
	return s.actor
}

// As returns a view acting for actorID with the intersection of its rights and the local actor's.
func (s *Session) As(actorID string) (*Session, error) {
	if actorID == "" {
		return nil, &Error{Code: InvalidParams, Message: "actor id is required"}
	}
	if actorID != localActor && !s.agent.severalActors {
		return nil, &Error{Code: NotSupported, Message: "several actors disabled"}
	}
	if s.actorID() != localActor && actorID != s.actorID() {
		return nil, &Error{Code: Forbidden, Message: "an actor view cannot change its identity"}
	}
	snap, err := s.agent.a.Snapshot(s.id)
	if err != nil {
		return nil, appError(err, NotOpen)
	}
	if _, ok := snap.Actors[actorID]; !ok && !(snap.Actors == nil && actorID == snap.Actor) {
		return nil, &Error{Code: Forbidden, Message: "actor is not a session member"}
	}
	return &Session{agent: s.agent, id: s.id, actor: actorID, approvalInstance: api.ID()}, nil
}

func (s *Session) require(ctx context.Context, right string) error {
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return appError(err, NotOpen)
	}
	if !s.agent.a.Authorize(s.id, s.actorID(), right) || !s.agent.a.Authorize(s.id, localActor, right) {
		return appError(api.ErrAuthority, Forbidden)
	}
	return nil
}

// Join adds or updates a session actor. By default the view's actor grants rights.
func (s *Session) Join(ctx context.Context, actor Actor, grantedBy ...string) error {
	if actor.ID != localActor && !s.agent.severalActors {
		return &Error{Code: NotSupported, Message: "several actors disabled"}
	}
	if err := validActor(actor); err != nil {
		return err
	}
	if len(grantedBy) > 1 {
		return &Error{Code: InvalidParams, Message: "at most one granter"}
	}
	if len(grantedBy) == 1 {
		view, err := s.As(grantedBy[0])
		if err != nil {
			return err
		}
		return view.Join(ctx, actor)
	}
	if err := s.require(ctx, "grant"); err != nil {
		return err
	}
	for _, right := range actor.Rights {
		if slices.Contains(api.Rights, right) {
			if err := s.require(ctx, right); err != nil {
				return err
			}
		}
	}
	return appError(s.agent.a.Grant(s.ctx(ctx), s.id, copyActor(actor)), Forbidden)
}

func (s *Session) Leave(ctx context.Context, actorID string) error {
	if actorID != localActor && !s.agent.severalActors {
		return &Error{Code: NotSupported, Message: "several actors disabled"}
	}
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	if s.actorID() != actorID {
		if err := s.require(ctx, "grant"); err != nil {
			return err
		}
	}
	err := s.agent.a.(interface {
		LeaveActor(context.Context, string, string) error
	}).LeaveActor(s.ctx(ctx), s.id, actorID)
	return appError(err, Forbidden)
}

// SetLimit replaces the session ceiling; nil removes it. Administer cannot be removed.
func (s *Session) SetLimit(ctx context.Context, rights []string) error {
	if !s.agent.sessionLimits {
		return &Error{Code: NotSupported, Message: "session limits disabled"}
	}
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return appError(err, NotOpen)
	}
	return appError(s.agent.a.(interface {
		Limit(context.Context, string, []string) error
	}).Limit(s.ctx(ctx), s.id, slices.Clone(rights)), Forbidden)
}

type QuestionsOptions struct{ Present bool }

func (s *Session) Questions(ctx context.Context, options ...QuestionsOptions) ([]Question, error) {
	if len(options) > 1 {
		return nil, &Error{Code: InvalidParams, Message: "at most one QuestionsOptions value"}
	}
	present := len(options) == 1 && options[0].Present
	if present && !s.agent.h.SupportsWaitingApprovals() {
		return nil, &Error{Code: NotSupported, Message: "waiting approvals are not supported"}
	}
	if err := s.require(ctx, "watch"); err != nil {
		return nil, err
	}
	view, err := s.view(ctx)
	if err != nil {
		return nil, err
	}
	visible := map[string]bool{}
	for _, entry := range view.Entries {
		if entry.Kind == "question.open" {
			visible[entry.ID] = true
		}
	}
	list, err := s.agent.q.manager().List(s.id)
	if err != nil {
		return nil, appError(err, NotOpen)
	}
	out := []Question{}
	for _, q := range list {
		if q.Answerable && visible[q.ID] {
			if q.ApprovalWait != "" {
				if present {
					if !s.agent.a.(api.WaitingApprovalHost).PresentApproval(s.ctx(ctx), q, "sdk", s.approvalInstance) {
						continue
					}
				} else if !s.agent.sdkApprovalView(s.ctx(ctx), q, "sdk") {
					continue
				}
			}

			out = append(out, sdkQuestion(q))
		}
	}
	return out, nil
}

func (s *Session) Answer(ctx context.Context, id string, answer Answer) error {
	if err := ctx.Err(); err != nil {
		return appError(err, CancelledCode)
	}
	if _, err := s.agent.a.Snapshot(s.id); err != nil {
		return appError(err, NotOpen)
	}
	a := api.Answer{Request: id, Value: answer.Value, Declined: answer.Declined, Reason: answer.Reason}
	m := s.agent.q.manager()
	var err error
	snap, _ := s.agent.a.Snapshot(s.id)
	waiting := false
	for _, w := range api.WaitingApprovals(snap) {
		if w.Question.ID == id {
			waiting = true
			break
		}
	}
	if waiting {
		err = s.agent.a.(api.WaitingApprovalHost).AnswerWaiting(s.ctx(ctx), s.id, s.approvalInstance, a)
	} else if s.actorID() == localActor {
		err = m.Answer(s.ctx(ctx), s.id, a)
	} else {
		err = m.AnswerFor(api.AsActor(ctx, localActor), s.id, s.actorID(), a)
	}
	switch {
	case errors.Is(err, api.ErrAnswerAuthority):
		return appError(err, Forbidden)
	case errors.Is(err, api.ErrInvalidAnswer):
		return appError(err, InvalidParams)
	case errors.Is(err, api.ErrQuestionNotFound):
		return appError(err, NotFound)
	default:
		return appError(err, Lost)
	}
}
