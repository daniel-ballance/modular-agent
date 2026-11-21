package proctest

import "testing"

func Subreaper(t *testing.T) {
	t.Helper()
	t.Skip("requires Linux child subreaper and /proc")
}
