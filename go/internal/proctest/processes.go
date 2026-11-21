// Package proctest contains subprocess acceptance helpers.
package proctest

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func Find(marker string) []int {
	if runtime.GOOS == "darwin" {
		out, _ := exec.Command("ps", "-axww", "-o", "pid=,command=").Output()
		var pids []int
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 && fields[1] == marker {
				pid, _ := strconv.Atoi(fields[0])
				pids = append(pids, pid)
			}
		}
		return pids
	}
	entries, _ := os.ReadDir("/proc")
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
		if bytes.Equal(bytes.Split(b, []byte{0})[0], []byte(marker)) {
			pids = append(pids, pid)
		}
	}
	return pids
}
func Await(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for subprocess state")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
func Gone(pid int) bool {
	if runtime.GOOS == "darwin" {
		out, _ := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "state=").Output()
		state := strings.TrimSpace(string(out))
		return state == "" || strings.HasPrefix(state, "Z")
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if os.IsNotExist(err) {
		return true
	}
	if err != nil {
		return false
	}
	f := strings.Fields(string(b)[strings.LastIndex(string(b), ")")+1:])
	return len(f) > 0 && f[0] == "Z"
}
func Reap(t *testing.T, pid int) {
	t.Helper()
	Await(t, func() bool {
		var status syscall.WaitStatus
		got, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
		return got == pid || err == syscall.ECHILD
	})
}
