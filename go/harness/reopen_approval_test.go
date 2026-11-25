package harness_test

import (
	"context"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/approval"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
)

func TestOpenUsesRecordedApprovalNotConfiguredDefault(t *testing.T) {
	for _, tc := range []struct{ name, recorded, want string }{
		{"missing", "", "all"},
		{"recorded off", "off", "off"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			dir, project := t.TempDir(), t.TempDir()
			store, err := history.New(dir)
			if err != nil {
				t.Fatal(err)
			}
			id := api.ID()
			lease, err := store.Acquire(id)
			if err != nil {
				t.Fatal(err)
			}
			defer lease.Close()
			setting := api.Entry{ID: api.ID(), Session: id, Kind: "setting", Data: api.JSON(api.Settings{Approval: tc.recorded})}
			if err := lease.Save(api.Session{Version: 1, ID: id, Project: project, Position: setting.ID, Entries: []api.Entry{setting}}); err != nil {
				t.Fatal(err)
			}
			if err := lease.Close(); err != nil {
				t.Fatal(err)
			}

			h := harness.New()
			defer h.Close()
			for _, plugin := range []api.Plugin{
				history.Plugin(dir),
				configuration.Plugin("", api.Settings{Approval: "never", MaxSteps: 8, MaxOutput: 256}),
				runtimetest.Plugin(t),
				approval.Plugin(),
			} {
				if err := h.Load(plugin); err != nil {
					t.Fatal(err)
				}
			}
			a := h.API()
			if err := a.Open(ctx, id); err != nil {
				t.Fatal(err)
			}
			snap, err := a.Snapshot(id)
			if err != nil {
				t.Fatal(err)
			}
			if got := api.ApprovalWire(snap.Settings.Approval); got != tc.want {
				t.Errorf("reopened approval = %q, want %q", got, tc.want)
			}
			if got := snap.Settings.MaxSteps; got != 8 {
				t.Errorf("reopened max steps = %d, want configured 8", got)
			}
		})
	}
}
