package resultcheck_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/resultcheck"
	"github.com/OWNER/modular-agent/go/vanilla"
	"strings"
	"testing"
)

func TestRejectedResultContinuesSameTurnAndRespectsStepLimit(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, accept := range []bool{true, false} {
			t.Run(map[bool]string{true: "repaired", false: "bounded"}[accept], func(t *testing.T) {
				p := fake.New(fake.Script{Response: api.Response{Content: api.Text("missing evidence"), Stop: "finished"}}, fake.Script{Require: "Include evidence", Response: api.Response{Content: api.Text("answer with evidence"), Stop: "finished"}})
				h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake"})
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				if err = h.Load(resultcheck.Plugin(func(c api.Content) string {
					if accept && strings.Contains(c.Text(), "with evidence") {
						return ""
					}
					return "Include evidence"
				})); err != nil {
					t.Fatal(err)
				}
				a := h.API()
				id, err := a.New(context.Background(), t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				s, _ := a.Snapshot(id)
				s.Settings.MaxSteps = 2
				_ = a.SetSettings(context.Background(), id, s.Settings)
				_, _ = a.Submit(context.Background(), id, api.Input{Content: api.Text("go")})
				out, err := a.Wait(context.Background(), id)
				if err != nil {
					t.Fatal(err)
				}
				if accept && out.Result.Text() != "answer with evidence" || !accept && out.Status != "limit" {
					t.Fatal(out)
				}
				s, _ = a.Snapshot(id)
				turns, reasons := 0, 0
				for _, e := range s.Entries {
					if e.Kind == "turn.start" {
						turns++
					}
					if e.Kind == "resultFeedback" && api.Decode[string](e.Data) == "Include evidence" {
						reasons++
					}
				}
				if turns != 1 || reasons == 0 || len(p.Requests()) != 2 {
					t.Fatal(turns, reasons)
				}
			})
		}
	})
}
