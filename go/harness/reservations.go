package harness

import (
	"sync"

	"github.com/daniel-ballance/modular-agent/go/portable"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// CapacityBounds are the limits for one scope. BufferedBytes accounts for
// retained queued input and the data reserved for a reporting job's input.
type CapacityBounds struct {
	Inputs        int64 `json:"inputs"`
	Calls         int64 `json:"calls"`
	Jobs          int64 `json:"jobs"`
	BufferedBytes int64 `json:"bufferedBytes"`
	StorageBytes  int64 `json:"storageBytes"`
	ControlBytes  int64 `json:"controlBytes"`
}

type CapacityLimits struct {
	Session CapacityBounds `json:"session"`
	Tenant  CapacityBounds `json:"tenant"`
	Agent   CapacityBounds `json:"agent"`
}

func DefaultCapacityLimits() CapacityLimits {
	return CapacityLimits{
		Session: CapacityBounds{64, 512, 64, 64 << 20, 4 << 30, 8 << 20},
		Tenant:  CapacityBounds{512, 4096, 256, 256 << 20, 32 << 30, 32 << 20},
		Agent:   CapacityBounds{2048, 8192, 1024, 1 << 30, 64 << 30, 128 << 20},
	}
}

func (b CapacityBounds) add(v CapacityBounds) CapacityBounds {
	return CapacityBounds{b.Inputs + v.Inputs, b.Calls + v.Calls, b.Jobs + v.Jobs, b.BufferedBytes + v.BufferedBytes, b.StorageBytes + v.StorageBytes, b.ControlBytes + v.ControlBytes}
}
func (b CapacityBounds) minus(v CapacityBounds) CapacityBounds {
	return b.add(CapacityBounds{-v.Inputs, -v.Calls, -v.Jobs, -v.BufferedBytes, -v.StorageBytes, -v.ControlBytes})
}
func (b CapacityBounds) permits(old, next CapacityBounds) bool {
	return next.Inputs <= max(old.Inputs, b.Inputs) && next.Calls <= max(old.Calls, b.Calls) &&
		next.Jobs <= max(old.Jobs, b.Jobs) && next.BufferedBytes <= max(old.BufferedBytes, b.BufferedBytes) &&
		next.StorageBytes <= max(old.StorageBytes, b.StorageBytes-b.ControlBytes) && next.ControlBytes <= max(old.ControlBytes, b.ControlBytes)
}

// Capacity keeps one ledger for the serving Harness and its project Harnesses.
// Session locks protect the corresponding snapshots; the ledger lock orders
// checks and successful commits across sessions.
type Capacity struct {
	limits   CapacityLimits
	mu       sync.Mutex
	seeded   bool
	sessions map[string]CapacityBounds
	tenants  map[string]CapacityBounds
	agent    CapacityBounds
}

func NewCapacity(limits CapacityLimits) *Capacity {
	return &Capacity{limits: limits, sessions: map[string]CapacityBounds{}, tenants: map[string]CapacityBounds{}}
}
func (h *Harness) Capacity() *Capacity { return h.capacity }
func (c *client) ReservationDeclaration() any {
	counts := func(b CapacityBounds) map[string]int64 {
		return map[string]int64{"inputs": b.Inputs, "calls": b.Calls, "jobs": b.Jobs}
	}
	l := c.h.CapacityLimits()
	return map[string]any{"session": counts(l.Session), "tenant": counts(l.Tenant), "agent": counts(l.Agent)}
}
func (h *Harness) UseCapacity(c *Capacity)        { h.capacity = c }
func (h *Harness) CapacityLimits() CapacityLimits { return h.capacity.limits }

func (c *client) seedCapacity() error {
	p := c.h.capacity
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seeded {
		return nil
	}
	if v, err := c.Get("history"); err == nil {
		all, err := v.(api.Store).List("")
		if err != nil {
			return err
		}
		for _, row := range all {
			p.update(row, snapshotCharges(row))
		}
	}
	p.seeded = true
	return nil
}

func (p *Capacity) update(row api.Session, next CapacityBounds) {
	delta := next.minus(p.sessions[row.ID])
	if next == (CapacityBounds{}) {
		delete(p.sessions, row.ID)
	} else {
		p.sessions[row.ID] = next
	}
	total := p.tenants[row.Tenant].add(delta)
	if total == (CapacityBounds{}) {
		delete(p.tenants, row.Tenant)
	} else {
		p.tenants[row.Tenant] = total
	}
	p.agent = p.agent.add(delta)
}

func (s *session) commitCapacity(next api.Session, save func() error) error {
	if s.h == nil || !changesCapacity(s.data, next) {
		return save()
	}
	p := s.h.capacity
	charge := s.capacityCharges(next)
	transferred := ""
	if !s.running && !s.opening && len(next.Entries) > len(s.data.Entries) {
		e := next.Entries[len(next.Entries)-1]
		if e.Kind == "input.accepted" {
			in := api.Decode[api.Input](e.Data)
			if in.Taken == "now" {
				transferred = in.ID
			}
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permits(next, charge) {
		return api.ErrCapacity
	}
	if err := save(); err != nil {
		return err
	}
	// Admission must fit before taking. Once handed to an idle Runtime the
	// slot is no longer queued. Its payload and write space stay charged.
	// On restart the record reconstructs the charge until the input is taken.
	if transferred != "" {
		s.transferredInput = transferred
		charge.Inputs--
	}
	p.update(next, charge)
	if s.responseClaim != nil {
		for _, e := range next.Entries {
			if e.Kind == "model" && e.Step == s.responseClaim.Step || e.Kind == "turn.end" && e.Turn == s.responseClaim.Turn {
				s.responseClaim = nil
				break
			}
		}
	}
	return nil
}

func (p *Capacity) permits(row api.Session, charge CapacityBounds) bool {
	old := p.sessions[row.ID]
	delta := charge.minus(old)
	tenant := p.tenants[row.Tenant]
	return p.limits.Session.permits(old, charge) && p.limits.Tenant.permits(tenant, tenant.add(delta)) && p.limits.Agent.permits(p.agent, p.agent.add(delta))
}

func (s *session) capacityCharges(next api.Session) CapacityBounds {
	if claim := s.responseClaim; claim != nil {
		for _, e := range next.Entries {
			if e.Kind == "model" && e.Step == claim.Step || e.Kind == "turn.end" && e.Turn == claim.Turn {
				return s.liveCharges(next)
			}
		}
		next.Entries = append(append([]api.Entry(nil), next.Entries...), *claim)
	}
	return s.liveCharges(next)
}

func (s *session) liveCharges(snap api.Session) CapacityBounds {
	b := snapshotCharges(snap)
	b.BufferedBytes += s.commandBytes
	if s.transferredInput != "" {
		for _, e := range pendingAdmissions(snap) {
			if api.Decode[api.Input](e.Data).ID == s.transferredInput {
				b.Inputs--
				break
			}
		}
	}
	return b
}

func (s *session) chargeCommandLocked(bytes int64) error {
	p := s.h.capacity
	p.mu.Lock()
	defer p.mu.Unlock()
	next := p.sessions[s.id]
	next.BufferedBytes += bytes
	if bytes > 0 && !p.permits(s.data, next) {
		return api.ErrCapacity
	}
	s.commandBytes += bytes
	p.update(s.data, next)
	return nil
}

// ReserveModelResponse exchanges the pending model slot for the whole call
// list. A served Runtime gets only the response the Harness can record.
func (p *turnPorts) ReserveModelResponse(step string, content api.Content) error {
	s := p.s
	s.mu.Lock()
	defer s.mu.Unlock()
	ledger := s.h.capacity
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	s.responseClaim = &api.Entry{Kind: "model", Session: s.id, Turn: p.id, Step: step, Content: content}
	charge := s.capacityCharges(s.data)
	if !ledger.permits(s.data, charge) {
		s.responseClaim = nil
		return api.ErrCapacity
	}
	ledger.update(s.data, charge)
	return nil
}

func changesCapacity(before, after api.Session) bool {
	return len(before.Entries) != len(after.Entries) || before.ForkedFrom != after.ForkedFrom
}

func snapshotCharges(row api.Session) (b CapacityBounds) {
	for _, e := range pendingAdmissions(row) {
		b.Inputs++
		b.BufferedBytes += int64(len(e.Data))
	}
	// The encoded record size is the logical quota. Native snapshots need
	// additional disk space for atomic replacement; the operator provisions it.
	for _, e := range row.Entries {
		size := int64(len(portable.HistoryEntry(row, e)) + 1)
		switch e.Kind {
		case "input.returned", "input.withdrawn", "actor.left", "limit", "job.cleanup", "erasure":
			b.ControlBytes += size
		default:
			b.StorageBytes += size
		}
	}
	jobs := map[string]struct{}{}
	turns := map[string]bool{}
	// The second map tracks model attempts; a committed response transfers
	// the call reservation to all call IDs it contains.
	attempts := map[string]string{}
	calls := map[string]bool{}
	for _, e := range row.LiveEntries() {
		switch {
		case e.Kind == "job.start":
			// Jobs can opt to report at job end on the wire.
			jobs[e.Job] = struct{}{}
		case e.WasKind("job.end"):
			delete(jobs, e.Job)
		case e.Kind == "model.request":
			attempts[e.Step] = e.Turn
		case e.WasKind("model"):
			delete(attempts, e.Step)
			for _, part := range e.Content {
				if part.Call != nil {
					calls[part.Call.ID] = true
				}
			}
		case e.Kind == "turn.start":
			turns[e.Turn] = true
		case e.WasKind("turn.end"):
			delete(turns, e.Turn)
			for step, turn := range attempts {
				if turn == e.Turn {
					delete(attempts, step)
				}
			}
		case e.Kind == "tool.call":
			calls[e.Call] = true
		case e.WasKind("tool.result"):
			delete(calls, e.Call)
		}
	}
	b.Calls = int64(len(attempts) + len(calls))
	b.Jobs = int64(len(jobs))
	b.Inputs += b.Jobs
	b.BufferedBytes += b.Jobs * api.JobReportBytes
	// Keep enough room for a bounded disposition or result in addition to
	// the committed intent. Taken inputs transfer their slot to a live turn.
	b.StorageBytes += 2*b.BufferedBytes + (b.Inputs+int64(len(turns)))*(4<<20) + b.Calls*(4<<20) + b.Jobs*(8<<20)
	return b
}
