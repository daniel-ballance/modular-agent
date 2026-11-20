package jobs

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"testing"
)

func TestPortableJobKeysAndCleanupAreSessionWide(t *testing.T) {
	s := api.Session{ID: "session"}
	for _, raw := range []string{
		`{"id":"started","parentId":null,"kind":"jobStarted","sessionId":"session","actorId":"local-user","writer":"owner","jobId":"job","data":{"kind":"test","key":"same","detail":null}}`,
		`{"id":"cleanup","parentId":"started","kind":"jobCleanupUnconfirmed","jobId":"job"}`,
		`{"id":"key-reservation","parentId":"cleanup","kind":"jobStarted","erased":true,"jobId":"older","jobKey":"same","writer":"other-owner"}`,
		`{"id":"move","parentId":"key-reservation","kind":"position","data":{"to":"started"}}`,
	} {
		e, err := portable.ReadEntry([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		s.Entries = append(s.Entries, e)
	}
	s = portable.Session(s)
	got := readJobs(s.ID, s.LiveEntries())
	if len(got) != 2 || got[0].State != "running" || !got[0].CleanupUnconfirmed || got[1].State != "erased" || got[1].Key != "same" || got[1].Owner != "other-owner" {
		t.Fatalf("job fold: %+v", got)
	}
}
