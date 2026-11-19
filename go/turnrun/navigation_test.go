package turnrun_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/vanilla"
	"testing"
)

func TestNavigationCannotTurnHistoricalWorkIntoCrashRecovery(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		p := fake.New(fake.Script{Response: firstResponse()}, fake.Script{Response: api.Response{Stop: "finished", Content: api.Text("finished")}})
		opt := fakeOptions(root, p, false)
		opt.Runtime = runtimetest.Plugin(t)
		h, err := vanilla.New(opt)
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		installEffects(t, h, root, "")
		id, err := h.API().New(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		h.API().Subscribe(func(api.Event) { panic("event observers cannot change execution") })
		_, err = h.API().Submit(context.Background(), id, api.Input{Content: api.Text("go")})
		if err != nil {
			t.Fatal(err)
		}
		out, err := h.API().Wait(context.Background(), id)
		if err != nil || out.Status != "completed" {
			t.Fatal(out, err)
		}
		snap, _ := h.API().Snapshot(id)
		target := ""
		for _, e := range snap.Entries {
			if e.Kind == "model" {
				target = e.ID
				break
			}
		}
		if err = h.API().Move(context.Background(), id, target, false); err == nil {
			t.Fatal("mid-turn move allowed")
		}
		if _, err = h.API().Fork(context.Background(), id, target); err == nil {
			t.Fatal("mid-turn fork allowed")
		}
		after, _ := h.API().Snapshot(id)
		if after.Position != snap.Position || len(after.Entries) != len(snap.Entries) {
			t.Fatal("refusal changed history")
		}
		if err = h.API().CloseSession(id); err != nil {
			t.Fatal(err)
		}
		out = wait(t, h.API(), id)
		if out.Status != "completed" || len(p.Requests()) != 2 {
			t.Fatal("completed work replayed", out, p.Requests())
		}
	})
}
