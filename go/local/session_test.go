package local_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/internal/proctest"
	"github.com/OWNER/modular-agent/go/local"
	"testing"
)

func TestSessionEndedStopsOnlyItsBackgroundProcesses(t *testing.T) {
	env := local.NewAt(t.TempDir())
	defer env.Close()
	cwd := t.TempDir()
	ctx := context.Background()
	first, second := "modular-session-first-"+api.ID(), "modular-session-second-"+api.ID()
	start := func(session, marker string) {
		t.Helper()
		work := api.WithExecution(ctx, api.Execution{Session: session})
		if _, err := env.Bash(work, cwd, "(exec -a "+marker+" sleep 60) &", nil); err != nil {
			t.Fatal(err)
		}
		proctest.Await(t, func() bool { return len(proctest.Find(marker)) == 1 })
	}
	start("first", first)
	start("second", second)
	if err := env.SessionEnded(ctx, "first"); err != nil {
		t.Fatal(err)
	}
	if len(proctest.Find(first)) != 0 || len(proctest.Find(second)) != 1 {
		t.Fatal("session end did not isolate the two sessions")
	}
	if err := env.SessionEnded(ctx, "second"); err != nil {
		t.Fatal(err)
	}
	if len(proctest.Find(second)) != 0 {
		t.Fatal("background process survived session end")
	}
}
