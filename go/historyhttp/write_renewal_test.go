package historyhttp

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Hold the append reply after commit so the renewal can run independently.
// Disk speed does not determine whether the reply crosses the old cutoff.
func TestAppendUsesRenewedWriterCutoff(t *testing.T) {
	b := &replyBarrier{
		appended: make(chan struct{}), release: make(chan struct{}),
	}
	c, err := NewLocalClient(b)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	writer, err := c.Acquire("session")
	if err != nil {
		t.Fatal(err)
	}
	l := writer.(*lease)
	l.writerMu.Lock()
	oldCutoff := l.cutoff
	l.writerMu.Unlock()
	result := make(chan error, 1)
	go func() {
		result <- writer.Save(api.Session{ID: "session", Version: 1, Entries: []api.Entry{{ID: "one", Kind: "test.opaque"}}})
	}()
	select {
	case <-b.appended:
	case err := <-result:
		t.Fatalf("append did not reach the reply barrier: %v", err)
	}
	time.Sleep(time.Duration(oldCutoff-leaseClock()) + 20*time.Millisecond)
	if err := l.CheckWriter(); err != nil {
		t.Fatalf("writer did not renew: %v", err)
	}
	close(b.release)
	if err := <-result; err != nil {
		t.Fatalf("append lost its reply despite a current writer: %v", err)
	}
}

// Unimplemented operations fail if the fixture accidentally tries to use them.
type replyBarrier struct {
	Backend
	appended, release chan struct{}
}

func (*replyBarrier) LeaseTTL() time.Duration { return 3 * time.Second }
func (*replyBarrier) Acquire(context.Context, string, string) (Grant, error) {
	return Grant{Lease: "test-lease", TTLMS: 3000}, nil
}
func (*replyBarrier) Renew(context.Context, string, string) (float64, error) { return 3000, nil }
func (*replyBarrier) Release(context.Context, string, string) error          { return nil }
func (*replyBarrier) Read(_ context.Context, id, _ string, _ int) (ReadPage, error) {
	return ReadPage{Session: Session{ID: id}}, nil
}
func (b *replyBarrier) Append(ctx context.Context, _, _ string, entries []json.RawMessage) (int, error) {
	close(b.appended)
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-b.release:
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		return len(entries), nil
	}
}
