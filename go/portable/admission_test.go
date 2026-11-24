package portable_test

import (
	"slices"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

func TestJobReleaseKeepsNarrowerCeiling(t *testing.T) {
	for _, released := range [][]string{{"watch"}, {}} {
		in := api.Input{ID: "in", Actor: "job:j", Job: "j", JobRights: []string{"input", "watch", "tools"}, ReleasedBy: "operator", ConnectionRights: &released, When: "after", Taken: "after", Content: api.Text("report")}
		raw := api.JSON(portable.Entry(api.Entry{ID: "admit", Session: "s", Kind: "input.accepted", Job: "j", Actor: "worker", InputRef: "in", Data: api.JSON(in)}))
		e, err := portable.ReadEntry(raw)
		if err != nil {
			t.Fatal(err)
		}
		work := api.Decode[api.Input](e.Data)
		if work.JobRights == nil || !slices.Equal(work.JobRights, released) || work.ReleasedBy != "operator" {
			t.Fatal("lost release restriction")
		}
	}
}
