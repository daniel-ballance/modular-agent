package modular

import (
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Last activity is the last entry in append order, not the largest time:
// clock skew can give an earlier entry a later time.
func TestSessionInfoLastActivityFollowsAppendOrder(t *testing.T) {
	at := func(ms int64) api.Entry { return api.Entry{Time: time.UnixMilli(ms)} }
	infos := sessionInfos([]api.Session{
		{ID: "skewed", Entries: []api.Entry{at(1000), at(9000), at(2000)}},
		{ID: "empty"},
	})
	if got := infos[0].LastActivity; !got.Equal(time.UnixMilli(2000)) {
		t.Fatalf("last activity %v, want the last entry's time", got)
	}
	if got := infos[0].CreatedAt; !got.Equal(time.UnixMilli(1000)) {
		t.Fatalf("created %v", got)
	}
	if !infos[1].LastActivity.IsZero() {
		t.Fatalf("a session with no entries has no activity: %v", infos[1].LastActivity)
	}
}
