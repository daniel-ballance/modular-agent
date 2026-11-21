package harness

import (
	"sync"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// CapacityBounds are the limits for one scope. BufferedBytes accounts for
// retained queued input and the data reserved for a reporting job's input.
type CapacityBounds struct {
	Inputs        int64 `json:"inputs"`
	Calls         int64 `json:"calls"`
	Jobs          int64 `json:"jobs"`
	BufferedBytes int64 `json:"bufferedBytes"`
}

type CapacityLimits struct {
	Session CapacityBounds `json:"session"`
	Tenant  CapacityBounds `json:"tenant"`
	Agent   CapacityBounds `json:"agent"`
}

func DefaultCapacityLimits() CapacityLimits {
	return CapacityLimits{
		Session: CapacityBounds{64, 512, 64, 64 << 20},
		Tenant:  CapacityBounds{512, 4096, 256, 256 << 20},
		Agent:   CapacityBounds{2048, 8192, 1024, 1 << 30},
	}
}

func (b CapacityBounds) add(v CapacityBounds) CapacityBounds {
	return CapacityBounds{b.Inputs + v.Inputs, b.Calls + v.Calls, b.Jobs + v.Jobs, b.BufferedBytes + v.BufferedBytes}
}
func (b CapacityBounds) minus(v CapacityBounds) CapacityBounds {
	return b.add(CapacityBounds{-v.Inputs, -v.Calls, -v.Jobs, -v.BufferedBytes})
}
func (b CapacityBounds) permits(old, next CapacityBounds) bool {
	return next.Inputs <= max(old.Inputs, b.Inputs) && next.Calls <= max(old.Calls, b.Calls) &&
		next.Jobs <= max(old.Jobs, b.Jobs) && next.BufferedBytes <= max(old.BufferedBytes, b.BufferedBytes)
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
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permits(next, charge) {
		return api.ErrCapacity
	}
	if err := save(); err != nil {
		return err
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
				return snapshotCharges(next)
			}
		}
		next.Entries = append(append([]api.Entry(nil), next.Entries...), *claim)
	}
	return snapshotCharges(next)
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
	if len(before.Entries) > len(after.Entries) || before.ForkedFrom != after.ForkedFrom {
		return true
	}
	for _, e := range after.Entries[len(before.Entries):] {
		switch e.Kind {
		case "input.accepted", "input", "input.returned", "input.withdrawn", "job.start", "job.end", "model.request", "model", "turn.end", "tool.call", "tool.result":
			return true
		}
	}
	return false
}

func snapshotCharges(row api.Session) (b CapacityBounds) {
	for _, e := range pendingAdmissions(row) {
		b.Inputs++
		b.BufferedBytes += int64(len(e.Data))
	}
	jobs := map[string]bool{}
	// The second map tracks model attempts; a committed response transfers
	// the call reservation to all call IDs it contains.
	attempts := map[string]string{}
	calls := map[string]bool{}
	for _, e := range row.LiveEntries() {
		switch {
		case e.Kind == "job.start":
			jobs[e.Job] = api.Decode[api.Job](e.Data).Report
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
		case e.WasKind("turn.end"):
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
	for _, report := range jobs {
		if report {
			b.Inputs++
			b.BufferedBytes += api.JobReportBytes
		}
	}
	return b
}
