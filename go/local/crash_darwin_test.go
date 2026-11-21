package local_test

import (
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/internal/proctest"
	"github.com/daniel-ballance/modular-agent/go/local"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAgentDeathStopsBackgroundGroup(t *testing.T) {
	if dir := os.Getenv("MA_GO_GROUP_TEST"); dir != "" {
		env := local.NewAt(filepath.Join(dir, "commands"))
		_, err := env.Bash(context.Background(), dir, "sleep 60 </dev/null >/dev/null 2>&1 & echo $! > child", nil)
		if err != nil {
			t.Fatal(err)
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	dir := t.TempDir()
	agent := exec.Command(os.Args[0], "-test.run=^TestAgentDeathStopsBackgroundGroup$")
	agent.Env = append(os.Environ(), "MA_GO_GROUP_TEST="+dir)
	agent.Stderr = os.Stderr
	if err := agent.Start(); err != nil {
		t.Fatal(err)
	}
	defer agent.Process.Kill()
	pid := 0
	proctest.Await(t, func() bool {
		data, _ := os.ReadFile(filepath.Join(dir, "child"))
		pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		return pid > 0
	})
	if proctest.Gone(pid) {
		t.Fatal(fmt.Errorf("background process %d did not survive foreground exit", pid))
	}
	if err := agent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = agent.Wait()
	proctest.Await(t, func() bool { return proctest.Gone(pid) })
}
