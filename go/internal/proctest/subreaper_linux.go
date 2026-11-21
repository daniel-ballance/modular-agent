package proctest

import (
	"syscall"
	"testing"
)

func Subreaper(t *testing.T) {
	t.Helper()
	// https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
	_, _, err := syscall.Syscall6(syscall.SYS_PRCTL, 36, 1, 0, 0, 0, 0)
	if err != 0 {
		t.Fatal(err)
	}
}
