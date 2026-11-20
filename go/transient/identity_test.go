package transient_test

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"testing"
)

func TestRepeatedProviderCallIdentityStillHasOneResultPerLocalCall(t *testing.T) {
	runtimetest.Each(t, testRepeatedProviderCallIdentityStillHasOneResultPerLocalCall)
}
func testRepeatedProviderCallIdentityStillHasOneResultPerLocalCall(t *testing.T) {
	call := func() fake.Script {
		return fake.Script{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "repeated", Name: "read", Input: api.JSON(map[string]string{"path": "missing"})}}}, Stop: "tools"}}
	}
	a, _, id := setup(t, call(), call(), fake.Script{Response: api.Response{Content: api.Text("done"), Stop: "finished"}})
	if out := run(t, a, id, "go"); out.Status != "completed" {
		t.Fatal(out)
	}
	snap, _ := a.Snapshot(id)
	calls, results := map[string]int{}, map[string]int{}
	for _, entry := range snap.Entries {
		if entry.Kind == "tool.call" {
			calls[entry.Call]++
		}
		if entry.Kind == "tool.result" {
			results[entry.Call]++
		}
	}
	if len(calls) != 2 {
		t.Fatal("Provider reused an agent-owned identity", calls)
	}
	for id, n := range calls {
		if n != 1 || results[id] != 1 {
			t.Fatal(calls, results)
		}
	}
}
