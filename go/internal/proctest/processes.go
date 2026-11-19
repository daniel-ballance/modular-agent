// Package proctest contains Linux-only subprocess acceptance helpers.
package proctest

import (
	"bytes"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func Find(marker string) []int {
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
func Subreaper(t *testing.T) {
	t.Helper()
	// https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
	_, _, err := syscall.Syscall6(syscall.SYS_PRCTL, 36, 1, 0, 0, 0, 0)
	if err != 0 {
		t.Fatal(err)
	}
}
func Reap(t *testing.T, pid int) {
	t.Helper()
	Await(t, func() bool {
		var status syscall.WaitStatus
		got, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
		return got == pid || err == syscall.ECHILD
	})
}
