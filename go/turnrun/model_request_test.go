package turnrun_test

import (
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/vanilla"
	"slices"
	"testing"
)

func TestPortableModelRequestRecovery(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		request bool
		safe    bool
		status  string
		step    string
	}{
		{"before the request", false, false, "completed", ""},
		{"safe in-flight request", true, true, "completed", "original-step"},
		{"unsafe in-flight request", true, false, "failed", ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			start := turnStart(nil)
			entries := []api.Entry{start}
			if scenario.request {
				entries = append(entries, api.Entry{Kind: "model.request", Turn: start.Turn, Step: "original-step", Data: api.JSON(api.Model{ID: "fake"}), SafeToRepeat: &scenario.safe})
			}
			id := seed(t, root, entries...)
			p := fake.New(fake.Script{Response: api.Response{Stop: "finished", Content: api.Text("done")}})
			opt := fakeOptions(root, p, true)
			if !scenario.safe {
				opt.Provider = api.Plugin{Name: "declared-fake", Setup: func(a api.API) error { return a.Provide("provider.fake", declaredProvider{p, true, false}) }}
			}
			h, err := vanilla.New(opt)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			out := wait(t, h.API(), id)
			if out.Status != scenario.status || (len(p.Requests()) == 1) != (out.Status == "completed") {
				t.Fatal(out, p.Requests())
			}
			if out.Status == "completed" {
				snap, err := h.API().Snapshot(id)
				if err != nil {
					t.Fatal(err)
				}
				var lastRequest api.Entry
				for _, e := range snap.Branch() {
					switch e.Kind {
					case "model.request":
						lastRequest = e
					case "model":
						if lastRequest.OfferedTools == nil || !slices.Contains(e.Copies, lastRequest.ID) {
							t.Fatalf("response lacks an intent with the final tool list and copy association: %+v", lastRequest)
						}
						if lastRequest.Step != e.Step || (scenario.step != "" && e.Step != scenario.step) {
							t.Fatalf("response %s has no prior request on the expected step: %+v", e.Step, lastRequest)
						}
					}
				}
			}
		})
	}
}
