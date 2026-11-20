package subagents_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"strings"
	"testing"
)

func TestErasureReachesWaitedJobCopiesAndNeverRestartsErasedWork(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		p := scripts(func(context.Context, api.Request, func(api.Part)) (api.Response, error) {
			return text("private child fact 193"), nil
		})
		h, id, jobs := newAgent(t, p, 3)
		a := h.API()
		ctx := context.Background()
		_, err := a.CallTool(ctx, id, api.Call{Name: "delegate", Input: api.JSON(map[string]any{"task": "do work", "background": false})})
		if err != nil {
			t.Fatal(err)
		}
		list, _ := jobs.List(id)
		d := api.Decode[struct{ Child string }](list[0].Detail)
		child, _ := a.Snapshot(d.Child)
		var target string
		for _, e := range child.Entries {
			if e.Kind == "model" {
				target = e.ID
			}
		}
		if err = a.Erase(ctx, id, []string{target}); err != nil {
			t.Fatal(err)
		}
		all, _ := a.List("")
		if strings.Contains(string(api.JSON(all)), "private child fact 193") {
			t.Fatal("job or tool-result copy retained private content")
		}
		list, _ = jobs.List(id)
		if len(list) != 1 || list[0].State != "erased" {
			t.Fatal("erased result looked unfinished", list)
		}
	})
}
