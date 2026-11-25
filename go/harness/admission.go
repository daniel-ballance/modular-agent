package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"slices"
	"strings"
)

func (c *client) Submit(ctx context.Context, id string, in api.Input) (receipt api.Receipt, errOut error) {
	ctx, span := telemetry.Start(telemetry.Session(ctx, id), "modular_agent.input.admit")
	defer func() {
		if receipt.ID != "" {
			span.SetAttributes(telemetry.String("modular_agent.input.id", receipt.ID))
		}
		telemetry.Finish(span, errOut)
	}()
	in.ConnectionRights = api.ConnectionRights(ctx)
	if in.Job != "" {
		return api.Receipt{}, api.ErrJobReportRefused
	}
	if strings.HasPrefix(in.Key, "job:") || strings.HasPrefix(in.Actor, "job:") || strings.HasPrefix(api.Acting(ctx), "job:") {
		return api.Receipt{}, errors.New("job report keys and actors are reserved")
	}
	s, err := c.find(id)
	if err != nil {
		return api.Receipt{}, err
	}
	if in.Actor == "" {
		in.Actor = api.Acting(ctx)
	}
	if in.ID == "" {
		in.ID = api.ID()
	}
	if in.When == "" {
		in.When = "now"
	}
	s.mu.Lock()
	if err := s.reconcileErasureLocked(); err != nil {
		s.mu.Unlock()
		return api.Receipt{}, err
	}
	if s.rewindBlocked {
		s.mu.Unlock()
		return api.Receipt{}, errRewindUnresolved
	}
	if !api.SessionScopeAllows(ctx, s.data.Project, s.data.Tenant) || !c.canAdmit(s.data, in) {
		s.mu.Unlock()
		return api.Receipt{}, api.ErrAuthority
	}
	if err := s.checkWriterLocked(); err != nil {
		s.mu.Unlock()
		return api.Receipt{}, err
	}
	if !api.InputWatermarkMatches(ctx, s.data) {
		s.mu.Unlock()
		return api.Receipt{}, api.ErrInputConflict
	}
	if r, ok := duplicate(s.data, in); ok {
		s.mu.Unlock()
		return r, nil
	}
	s.mu.Unlock()
	if in.When != "propose" {
		// Delegated input may not execute slash commands: those commands
		// accept a single actor and cannot check both contributors' rights.
		if in.ViaActor != "" && strings.HasPrefix(strings.TrimSpace(in.Content.Text()), "/") {
			return api.Receipt{}, errors.New("delegated input cannot run a command")
		}
		v, err := c.h.API().Invoke(api.AsActor(ctx, in.Actor), "input", api.InputEvent{Session: id, Input: in})
		if err != nil {
			return api.Receipt{}, err
		}
		event := v.(api.InputEvent)
		if event.Handled {
			s.mu.Lock()
			defer s.mu.Unlock()
			entry, err := api.OperationEntry(ctx, s.data)
			if err != nil {
				return api.Receipt{}, err
			}
			if entry != "" {
				if !api.InputWatermarkMatches(ctx, s.data) || !c.authorizedBy(s.data, ctx, "input") {
					return api.Receipt{}, api.ErrInputConflict
				}
				next := s.data
				next.Entries = slices.Clip(next.Entries)
				in.Taken = "now"
				appendEntry(&next, api.Entry{ID: entry, Kind: "input.accepted", InputRef: in.ID, Actor: in.Actor, Data: api.JSON(in), Content: in.Content}, "harness", true)
				appendEntry(&next, api.Entry{Kind: "input.returned", Actor: in.Actor, InputRef: in.ID, Copies: []string{entry}, Data: api.JSON("handled")}, "harness", true)
				if err := s.publishInitialLocked(next, ctx); err != nil {
					return api.Receipt{}, err
				}
			}
			return api.Receipt{ID: in.ID, When: "command", Command: event.Result}, nil
		}
		event.Input.Actor, event.Input.ViaActor, event.Input.ConnectionRights = in.Actor, in.ViaActor, in.ConnectionRights
		in = event.Input
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !api.SessionScopeAllows(ctx, s.data.Project, s.data.Tenant) || !c.canAdmit(s.data, in) {
		return api.Receipt{}, api.ErrAuthority
	}
	if !api.InputWatermarkMatches(ctx, s.data) {
		return api.Receipt{}, api.ErrInputConflict
	}
	if r, ok := duplicate(s.data, in); ok {
		return r, nil
	}
	starting := []string{}
	for _, right := range api.Rights {
		if api.ConnectionAllows(ctx, right) && c.authorized(s.data, in.Actor, right) &&
			(in.ViaActor == "" || c.authorized(s.data, in.ViaActor, right)) {
			starting = append(starting, right)
		}
	}
	in.ConnectionRights = &starting
	in.TraceContext = telemetry.WorkWire(ctx)
	r, err := c.admitLocked(s, in, ctx)
	if errors.Is(err, api.ErrCapacity) {
		telemetry.Event(ctx, "modular_agent.capacity.refused")
	}
	return r, err
}
func duplicate(s api.Session, input api.Input) (api.Receipt, bool) {
	key := input.Key
	submitter := func(actor, via string) string {
		if via != "" {
			return via
		}
		return actor
	}
	scope := func(actor, via string) bool {
		return actor != "" && actor == input.Actor && submitter(actor, via) == submitter(input.Actor, input.ViaActor)
	}
	if key != "" {
		for _, e := range s.LiveEntries() {
			if e.Kind != "erasure" || e.IsErased() {
				continue
			}
			for _, reservation := range api.ReadErasureRecord(e.Data).InputKeys {
				if reservation.Key == key && scope(reservation.ActorID, reservation.SubmittedBy) && !slices.ContainsFunc(s.Entries, func(candidate api.Entry) bool {
					return candidate.Kind == "input.accepted" && recordedInputID(candidate) == reservation.InputID
				}) {
					return api.Receipt{Duplicate: true, Erased: true}, true
				}
			}
		}
		for _, e := range s.LiveEntries() {
			if e.Kind == "input" && e.InputKey == key && scope(e.Actor, "") {
				return api.Receipt{ID: e.InputID(), When: "now", Duplicate: true}, true
			}
			if e.Kind == "input.accepted" {
				in := api.Decode[api.Input](e.Data)
				if in.Key == key && scope(in.Actor, in.ViaActor) {
					taken := in.Taken
					if taken == "" && in.When == "propose" {
						taken = "proposed"
					}
					return api.Receipt{ID: in.ID, When: taken, Duplicate: true}, true
				}
			}
		}
	}
	return api.Receipt{}, false
}
func (s *session) takeLocked(in api.Input, turn string) (api.Entry, error) {
	var source string
	actor := in.Actor
	for _, e := range s.data.Entries {
		if e.Kind == "input" && e.InputRef == in.ID {
			return e, nil
		}
		if e.Kind == "input.accepted" && api.Decode[api.Input](e.Data).ID == in.ID {
			source = e.ID
			// Keep the admission's attribution. Job rights still govern the
			// work; the synthetic in-process job actor is not a member.
			if in.Job != "" && e.Actor != "" {
				actor = e.Actor
			}
		}
	}
	sources := append([]string(nil), in.Copies...)
	if source != "" {
		sources = append(sources, source)
	}
	return s.recordLocked(api.Entry{Kind: "input", Turn: turn, Visible: true, Content: in.Content, Actor: actor, Job: in.Job, Copies: sources, InputKey: in.Key, InputRef: in.ID}, "harness", true)
}

func recordedInputID(e api.Entry) string {
	switch e.Kind {
	case "input":
		return e.InputID()
	case "input.accepted":
		return api.Decode[api.Input](e.Data).ID
	}
	return ""
}

func (c *client) Withdraw(ctx context.Context, id, input string) (api.Input, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Input{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, in := range s.queue {
		if in.ID == input {
			if api.Acting(ctx) != in.Actor && !c.authorized(s.data, api.Acting(ctx), "input") {
				return api.Input{}, errors.New("withdraw refused")
			}
			if _, err = s.recordLocked(api.Entry{Kind: "input.returned", InputRef: input, Data: api.JSON("withdrawn")}, "harness", true); err != nil {
				return api.Input{}, err
			}
			s.queue = append(s.queue[:i], s.queue[i+1:]...)
			return in, nil
		}
	}
	return api.Input{}, errors.New("input already taken")
}

func (p *turnPorts) TakeSteering(ctx context.Context) (bool, error) {
	entries, err := p.TakeSteeringEntries(ctx)
	return len(entries) > 0, err
}
func (p *turnPorts) TakeSteeringEntries(ctx context.Context) ([]api.Entry, error) {
	return p.TakeSteeringBoundary(ctx, false)
}

func (p *turnPorts) TakeSteeringBoundary(ctx context.Context, final bool) ([]api.Entry, error) {
	s := p.s
	s.mu.Lock()
	defer s.mu.Unlock()
	var entries []api.Entry
	for i := 0; i < len(s.queue); {
		in := s.queue[i]
		if in.When != "steer" {
			i++
			continue
		}
		if err := ctx.Err(); err != nil {
			return entries, err
		}
		e, err := s.takeLocked(in, p.id)
		if err != nil {
			return entries, err
		}
		entries = append(entries, e)
		s.queue = slices.Delete(s.queue, i, i+1)
	}
	if final && len(entries) == 0 {
		s.steeringClosed = true
	}
	return entries, nil
}
func (p *turnPorts) HasSteering() bool {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	return slices.ContainsFunc(p.s.queue, func(in api.Input) bool { return in.When == "steer" })
}

func (c *client) canAdmit(s api.Session, in api.Input) bool {
	right := "input"
	if in.When == "propose" {
		right = "propose"
	}
	if in.ConnectionRights != nil && !slices.Contains(*in.ConnectionRights, right) {
		return false
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
	if s.opening || s.closing || s.running || s.writerFailure != nil {
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

func (c *client) admitLocked(s *session, in api.Input, contexts ...context.Context) (api.Receipt, error) {
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
	next := s.data
	next.Entries = slices.Clip(next.Entries)
	if !slices.ContainsFunc(next.Entries, func(e api.Entry) bool { return e.Kind == "setting" }) {
		appendEntry(&next, api.Entry{Kind: "setting", Data: api.JSON(next.Settings)}, "harness", true)
	}
	id, err := api.OperationEntry(firstContext(contexts), s.data)
	if err != nil {
		return api.Receipt{}, err
	}
	appendEntry(&next, api.Entry{ID: id, Kind: "input.accepted", InputRef: in.ID, Job: in.Job, Data: api.JSON(in), Content: in.Content, Actor: attribution, Copies: in.Copies}, "harness", true)
	if err := s.publishInitialLocked(next, contexts...); err != nil {
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
	if s.closing || !c.authorizedBy(s.data, ctx, "input") {
		return api.Receipt{}, errors.New("input release refused")
	}
	for _, e := range pendingProposals(s.data) {
		in := api.Decode[api.Input](e.Data)
		if in.ID != input {
			continue
		}
		if declined {
			_, err := s.recordLocked(api.Entry{Kind: "input.returned", Actor: by, InputRef: input, Data: api.JSON("declined")}, "harness", true)
			return api.Receipt{ID: input, When: "handedBack"}, err
		}
		if !c.canAdmit(s.data, in) {
			return api.Receipt{}, errors.New("proposer no longer has authority")
		}
		in.When, in.ReleasedBy = when, by
		in.ConnectionRights = api.IntersectConnectionRights(in.ConnectionRights, api.ConnectionRights(ctx))
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
	if !c.authorizedBy(s.data, ctx, "watch") {
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
		can := func(right string) bool {
			return api.ConnectionAllows(ctx, right) && c.authorized(s.data, by, right) && c.authorized(s.data, who, right)
		}
		if !can("input") && !(who == in.Actor && can("propose")) {
			return errors.New("withdraw refused")
		}
		_, err := s.recordLocked(api.Entry{Kind: "input.returned", Actor: who, InputRef: input, Data: api.JSON("withdrawn")}, c.owner, true)
		return err
	}
	return errors.New("no pending proposal with that input id")
}

func turnAdmission(s api.Session, start api.Entry) api.Input {
	draft := api.Decode[api.TurnStart](start.Data)
	id := draft.Input
	if id == "" && draft.ContinuesTurn != "" {
		for _, origin := range s.Branch() {
			if origin.ID == start.ID {
				break
			}
			if origin.Kind == "turn.start" && origin.Turn == draft.ContinuesTurn {
				return turnAdmission(s, origin)
			}
		}
	}
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
	return p.checkTools(actor, func(who string) bool { return p.c.Authorize(p.s.id, who, "tools") })
}

func (p *turnPorts) canRunToolsLocked(actor string) bool {
	return p.checkTools(actor, func(who string) bool { return p.c.authorized(p.s.data, who, "tools") })
}

func (p *turnPorts) checkTools(actor string, allowed func(string) bool) bool {
	if p.input.ConnectionRights != nil && !slices.Contains(*p.input.ConnectionRights, "tools") {
		return false
	}
	if p.input.Job != "" && p.input.JobRights != nil && !slices.Contains(p.input.JobRights, "tools") {
		return false
	}
	for _, who := range []string{actor, p.input.Actor, p.input.ReleasedBy, p.input.ViaActor} {
		if who != "" && !allowed(who) {
			return false
		}
	}
	return actor != ""
}
