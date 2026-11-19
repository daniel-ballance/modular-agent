package local_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/internal/proctest"
	"github.com/OWNER/modular-agent/go/local"
	"syscall"
	"testing"
	"time"
)

func TestCloseStopsTrackedBackgroundProcess(t *testing.T) {
	env := local.New()
	defer env.Close()
	marker := "modular-background-" + api.ID()
	_, err := env.Bash(context.Background(), t.TempDir(), "(exec -a "+marker+" sleep 60) &", func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	proctest.Await(t, func() bool { return len(proctest.Find(marker)) == 1 })
	pid := proctest.Find(marker)[0]
	if err = syscall.Kill(pid, 0); err != nil {
		t.Fatal("background process did not survive shell exit", err)
	}
	if err = env.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if err = syscall.Kill(pid, 0); err == syscall.ESRCH {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background PID survived environment close", pid, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
