package harness

import (
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
)

func TestCapacityRecountsChangedRecordsAndEncoding(t *testing.T) {
	row := api.Session{ID: "session", Entries: []api.Entry{
		{ID: "first", Kind: "input", Content: api.Text("a")},
		{ID: "second", Kind: "input", Content: api.Text("b"), Wire: api.JSON(map[string]any{"id": "second", "data": "foreign content"})},
	}}
	s := &session{data: row}
	s.storageCharges = s.recordSizes(row)
	next := copySession(row)
	next.Entries[0].Content = api.Text("a much longer input")
	next.Entries = append(next.Entries, api.Entry{ID: "third", Kind: "limit"})
	check := func(next api.Session) {
		t.Helper()
		if got, want := s.capacityCharges(next, s.recordSizes(next)), snapshotCharges(next); got != want {
			t.Fatalf("reused charges: %+v; full scan: %+v", got, want)
		}
	}
	check(next)
	next.HistoryMeta = api.JSON(map[string]any{"id": next.ID})
	check(next)
}

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
