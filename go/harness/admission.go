package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"slices"
)

func (c *client) canAdmit(s api.Session, in api.Input) bool {
	right := "input"
	if in.When == "propose" {
		right = "propose"
	}
	if in.Job != "" && in.JobRights != nil && !slices.Contains(in.JobRights, right) {
		return false
	}
	return c.authorized(s, in.Actor, right) && (in.ViaActor == "" || c.authorized(s, in.ViaActor, right)) &&
		(in.ReleasedBy == "" || c.authorized(s, in.ReleasedBy, "input"))
}

func (c *client) enqueueLocked(s *session, in api.Input) {
	s.queue = append(s.queue, in)
	c.startQueuedLocked(s)
}

func (c *client) startQueuedLocked(s *session) {
	if s.opening || s.closing || s.running {
		return
	}
	i := runnableInput(s.queue)
	if i < 0 {
		return
	}
	in := s.queue[i]
	s.queue = slices.Delete(s.queue, i, i+1)
	s.running, s.activeActor, s.activeInput, s.done = true, in.Actor, in, make(chan struct{})
	runCtx, cancel := context.WithCancelCause(context.Background())
	s.cancel = cancel
	go c.h.run(runCtx, s, in)
}

func (c *client) admitLocked(s *session, in api.Input) (api.Receipt, error) {
	if s.closing {
		return api.Receipt{}, errors.New("session closing")
	}
	attribution := in.Actor
	if in.Job != "" {
		in.Parked = nil // disposition is recorded only on the initial admission
		for _, e := range s.data.LiveEntries() {
			if e.Kind == "job.start" && e.Job == in.Job {
				attribution = e.Actor
				break
			}
		}
		if in.When == "steer" {
			in.When = "after"
		}
	}
	switch in.When {
	case "propose":
		in.Taken = "proposed"
	case "now", "steer", "after":
		switch {
		case !s.running && !s.opening && runnableInput(s.queue) < 0:
			in.When, in.Taken = "now", "now"
		case in.When == "steer" && s.running && !s.steeringClosed && s.activeInput.ID != "" && c.supportsSteering():
			if s.activeActor != in.Actor || s.activeInput.ViaActor != in.ViaActor || s.activeInput.ReleasedBy != in.ReleasedBy {
				return api.Receipt{}, api.ErrInputConflict
			}
			in.Taken = "inTurn"
		default:
			in.When, in.Taken = "after", "after"
		}
	default:
		return api.Receipt{}, errors.New("invalid input timing")
	}
	if !slices.ContainsFunc(s.data.Entries, func(e api.Entry) bool { return e.Kind == "setting" }) {
		if _, err := s.recordLocked(api.Entry{Kind: "setting", Data: api.JSON(s.data.Settings)}, "harness", true); err != nil {
			return api.Receipt{}, err
		}
	}
	if _, err := s.recordLocked(api.Entry{Kind: "input.accepted", Job: in.Job, Data: api.JSON(in), Content: in.Content, Actor: attribution, Copies: in.Copies}, "harness", true); err != nil {
		return api.Receipt{}, err
	}
	if !parked(in) && !s.opening {
		c.enqueueLocked(s, in)
	}
	return api.Receipt{ID: in.ID, When: in.Taken}, nil
}

func (c *client) supportsSteering() bool {
	runtime, err := c.Get("runtime")
	return err == nil && runtime.(api.Runtime).Declaration().Steering
}

func (c *client) ReleaseInput(ctx context.Context, id, input, when string, declined bool) (api.Receipt, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Receipt{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	by := api.Acting(ctx)
	if s.closing || !c.authorized(s.data, by, "input") {
		return api.Receipt{}, errors.New("input release refused")
	}
	for _, e := range pendingProposals(s.data) {
		in := api.Decode[api.Input](e.Data)
		if in.ID != input {
			continue
		}
		if declined {
			_, err := s.recordLocked(api.Entry{Kind: "input.returned", Actor: by, InputRef: input}, "harness", true)
			return api.Receipt{ID: input, When: "handedBack"}, err
		}
		if !c.canAdmit(s.data, in) {
			return api.Receipt{}, errors.New("proposer no longer has authority")
		}
		in.When, in.ReleasedBy = when, by
		in.Copies = append(in.Copies, e.ID)
		return c.admitLocked(s, in)
	}
	return api.Receipt{}, errors.New("no pending proposal with that input id")
}

func (c *client) Proposals(ctx context.Context, id string) ([]api.Entry, error) {
	s, err := c.find(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !c.authorized(s.data, api.Acting(ctx), "watch") {
		return nil, errors.New("watch refused")
	}
	return pendingProposals(s.data), nil
}

func pendingProposals(s api.Session) []api.Entry {
	var out []api.Entry
	for _, e := range pendingAdmissions(s) {
		if parked(api.Decode[api.Input](e.Data)) {
			out = append(out, clone(e))
		}
	}
	return out
}

func (c *client) WithdrawProposal(ctx context.Context, id, input, who string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	by := api.Acting(ctx)
	if who == "" {
		who = by
	}
	if _, ok := actors(s.data)[who]; !ok {
		return errors.New("unknown withdrawing actor")
	}
	for _, e := range pendingProposals(s.data) {
		in := api.Decode[api.Input](e.Data)
		if in.ID != input {
			continue
		}
		can := func(right string) bool { return c.authorized(s.data, by, right) && c.authorized(s.data, who, right) }
		if !can("input") && !(who == in.Actor && can("propose")) {
			return errors.New("withdraw refused")
		}
		_, err := s.recordLocked(api.Entry{Kind: "input.returned", Actor: who, Data: api.JSON([]string{input})}, c.owner, true)
		return err
	}
	return errors.New("no pending proposal with that input id")
}

func turnAdmission(s api.Session, start api.Entry) api.Input {
	id := api.Decode[api.TurnStart](start.Data).Input
	for _, e := range s.Branch() {
		if e.Kind == "input" && e.Turn == start.Turn {
			id = e.InputID()
			break
		}
	}
	var in api.Input
	for _, e := range s.LiveEntries() {
		if e.ID == start.ID {
			break
		}
		if e.Kind == "input.accepted" && id != "" {
			if accepted := api.Decode[api.Input](e.Data); accepted.ID == id {
				in = accepted
			}
		}
	}
	return in
}

func (p *turnPorts) canRunTools(actor string) bool {
	if p.input.Job != "" && p.input.JobRights != nil && !slices.Contains(p.input.JobRights, "tools") {
		return false
	}
	for _, who := range []string{actor, p.input.Actor, p.input.ReleasedBy, p.input.ViaActor} {
		if who != "" && !p.c.Authorize(p.s.id, who, "tools") {
			return false
		}
	}
	return actor != ""
}
