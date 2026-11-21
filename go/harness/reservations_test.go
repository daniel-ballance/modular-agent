package harness

import (
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
)

func TestOutputSharesPendingByteBudgetAcrossScopes(t *testing.T) {
	limits := DefaultCapacityLimits()
	limits.Session.BufferedBytes, limits.Tenant.BufferedBytes, limits.Agent.BufferedBytes = 10, 15, 20
	p := NewCapacity(limits)
	p.update(api.Session{ID: "a", Tenant: "t"}, CapacityBounds{BufferedBytes: 4})
	a := p.reserveOutput("a", "t", 6)
	if a == nil || p.reserveOutput("a", "t", 1) != nil || p.reserveOutput("b", "t", 6) != nil {
		t.Fatal("session or tenant pool was overcommitted")
	}
	b := p.reserveOutput("b", "u", 10)
	if b == nil || p.reserveOutput("c", "w", 1) != nil {
		t.Fatal("agent pool was overcommitted")
	}
	if p.permits(api.Session{ID: "a", Tenant: "t"}, CapacityBounds{BufferedBytes: 5}) {
		t.Fatal("admission bypassed the buffer charge")
	}
	a()
	a()
	b()
	if p.agentOutput != 0 || len(p.output) != 0 || len(p.tenantOutput) != 0 {
		t.Fatal("output charge not released exactly once")
	}
}
