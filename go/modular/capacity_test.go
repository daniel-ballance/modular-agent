package modular_test

import (
	"errors"
	"sync"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

func TestConcurrentAdmissionsShareTheNoTenantBucket(t *testing.T) {
	limits := modular.DefaultCapacityLimits()
	limits.Tenant.Inputs = 1
	a, err := modular.New(t.Context(), modular.WithProject(t.TempDir()), modular.WithSeveralActors(true), modular.WithCapacityLimits(limits))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	sessions := make([]*modular.Session, 2)
	for i := range sessions {
		sessions[i], err = a.Session(t.Context())
		if err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	var receipt [2]modular.InputReceipt
	var refusal [2]error
	start := make(chan struct{})
	for i, s := range sessions {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			receipt[i], refusal[i] = s.Send(t.Context(), "held proposal", modular.Propose, modular.WithInputKey("once"))
		}()
	}
	close(start)
	wg.Wait()
	winner, loser := 0, 1
	if refusal[0] != nil {
		winner, loser = 1, 0
	}
	var sdk *modular.Error
	if refusal[winner] != nil || !errors.As(refusal[loser], &sdk) || sdk.Code != modular.Busy || receipt[loser].InputID != "" {
		t.Fatalf("want one admission and one busy without receipt: %v, %v", receipt, refusal)
	}
	again, err := sessions[winner].Send(t.Context(), "held proposal", modular.Propose, modular.WithInputKey("once"))
	if err != nil || !again.Duplicate || again.InputID != receipt[winner].InputID {
		t.Fatal(again, err)
	}
	if err := sessions[winner].Withdraw(t.Context(), receipt[winner].InputID); err != nil {
		t.Fatal(err)
	}
	again, err = sessions[loser].Send(t.Context(), "held proposal", modular.Propose, modular.WithInputKey("once"))
	if err != nil || again.Duplicate || again.InputID == "" {
		t.Fatal(again, err)
	}
}
