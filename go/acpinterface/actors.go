package acpinterface

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
	"sort"

	acp "github.com/caelis-labs/acp-go-sdk"
)

type actorSessions interface {
	NewForHost(context.Context, string, string, api.Actor) (string, error)
	OpenForHost(context.Context, string, api.Actor) error
	LeaveActor(context.Context, string, string) error
	ReleaseInput(context.Context, string, string, string, bool) (api.Receipt, error)
}

func invalidActorRequest(err error) error {
	if errors.Is(err, api.ErrCapacity) {
		return acpError("busy")
	}
	if errors.Is(err, api.ErrAuthority) || errors.Is(err, api.ErrAnswerAuthority) {
		return acpError("forbidden")
	}
	if errors.Is(err, api.ErrInputConflict) {
		return acpError("conflict")
	}
	if errors.Is(err, api.ErrOutputWithheld) {
		return outputReplyError(err)
	}
	return acpError("invalid_params")
}

func acpError(code string) *acp.RequestError {
	return &acp.RequestError{Code: -32602, Message: "Request refused", Data: map[string]string{"code": code}}
}

func validTiming(when string) bool {
	return when == "now" || when == "steer" || when == "after"
}

func receiptValue(receipt api.Receipt) map[string]any {
	if receipt.Erased {
		return map[string]any{"erased": true, "duplicate": true}
	}
	taken := receipt.When
	switch taken {
	case "steer":
		taken = "inTurn"
	case "command":
		taken = "now"
	case "propose": // keyed duplicate of a proposal
		taken = "proposed"
	}
	out := map[string]any{"inputId": receipt.ID, "taken": taken}
	if receipt.Duplicate {
		out["duplicate"] = true
	}
	return out
}

func (s *server) actors(ctx context.Context, id, who string) (any, error) {
	if !s.authorize(id, who, "watch") {
		return nil, invalidActorRequest(errors.New("watch refused"))
	}
	snap, err := s.a.View(ctx, id)
	if err != nil {
		return nil, err
	}
	actors := make([]api.Actor, 0, len(snap.Actors))
	for _, a := range snap.Actors {
		a.Rights = append([]string{}, a.Rights...)
		actors = append(actors, a)
	}
	sort.Slice(actors, func(i, j int) bool { return actors[i].ID < actors[j].ID })
	present := []string{}
	presence, ok := s.questions().(interface{ Present(string, string) bool })
	for _, a := range actors {
		if a.ID == who || ok && presence.Present(id, a.ID) {
			present = append(present, a.ID)
		}
	}
	return map[string]any{"actors": actors, "present": present}, nil
}

func (s *server) join(ctx context.Context, id string, actor api.Actor, present bool) (any, error) {
	if !slices.Contains([]string{"user", "host", "agent", "program"}, actor.Kind) {
		return nil, invalidActorRequest(errors.New("unknown actor kind"))
	}
	actor.Rights = append([]string{}, actor.Rights...)
	if err := s.a.Grant(ctx, id, actor); err != nil {
		return nil, invalidActorRequest(err)
	}
	// A recorded grant cannot change connection representation.
	if s.represents[actor.ID] {
		s.setPresence(id, actor.ID, present)
	}
	return map[string]any{}, nil
}

func (s *server) setPresence(id, who string, present bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.sessions[id]
	if st == nil || s.closed || who == st.actor {
		return
	}
	if disconnect := st.joined[who]; disconnect != nil {
		disconnect()
		delete(st.joined, who)
	}
	if present {
		st.joined[who] = s.questions().Connect(id, who)
	} else {
		for k := range st.polled {
			if k.actor == who {
				delete(st.polled, k)
			}
		}
		for k, cancel := range st.requests {
			if k.actor == who {
				cancel()
			}
		}
	}
}

func (s *server) proposals(ctx context.Context, id string) (any, error) {
	out, err := s.a.(interface {
		Proposals(context.Context, string) ([]api.Entry, error)
	}).Proposals(ctx, id)
	if err != nil {
		return nil, invalidActorRequest(err)
	}
	proposals := []map[string]any{}
	for _, e := range out {
		in := api.Decode[api.Input](e.Data)
		proposals = append(proposals, map[string]any{"inputId": in.ID, "actorId": e.Actor, "content": contentBlocks(in.Content), "time": e.Time.UnixMilli()})
	}
	return map[string]any{"proposals": proposals}, nil
}

func (s *server) answerFor(ctx context.Context, id, who string, answer api.Answer) error {
	if who == "" || who == api.Acting(ctx) {
		return s.questions().Answer(ctx, id, answer)
	}
	snap, err := s.a.Snapshot(id)
	if err != nil {
		return err
	}
	if _, joined := snap.Actors[who]; !joined {
		return api.ErrAnswerAuthority
	}
	if q, ok := s.questions().(interface {
		AnswerFor(context.Context, string, string, api.Answer) error
	}); ok {
		return q.AnswerFor(ctx, id, who, answer)
	}
	return api.ErrAnswerAuthority
}
