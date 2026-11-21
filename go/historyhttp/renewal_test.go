package historyhttp_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
)

// The response stalls after the service commits an unrelated write. The
// writer must be able to renew while that request is still in progress.
func TestFileHistoryRenewsDuringUnrelatedWrite(t *testing.T) {
	const ttl = 2500 * time.Millisecond
	s, err := historyhttp.New(t.TempDir(), ttl)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	handler := s.Handler("test-token")
	stalled, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	renewed := make(chan int, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/renew") {
			handler.ServeHTTP(w, r)
			return
		}
		reply := httptest.NewRecorder()
		handler.ServeHTTP(reply, r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.Code)
		_, _ = w.Write(reply.Body.Bytes())
		select {
		case renewed <- reply.Code:
		default:
		}
	}))
	defer ts.Close()
	wire := servicehttp.NewClient(ts.URL, "test-token")
	c := historyhttp.NewClient(wire)
	defer c.Close()
	create := func(id string) *http.Request {
		r := httptest.NewRequest("PUT", "/v1/sessions/"+id, strings.NewReader(`{"project":"/p","created":1}`))
		r.Header.Set("Authorization", "Bearer test-token")
		r.Header.Set("Content-Type", "application/json")
		return r
	}
	initial := httptest.NewRecorder()
	handler.ServeHTTP(initial, create("writer"))
	if initial.Code != 200 {
		t.Fatal(initial.Code, initial.Body)
	}
	l, err := c.Acquire("writer")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(finished)
		handler.ServeHTTP(stalledResponse{httptest.NewRecorder(), stalled, release}, create("unrelated"))
	}()
	defer func() { close(release); <-finished }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	select {
	case <-stalled:
	case <-ctx.Done():
		t.Fatal("unrelated commit did not reach its reply")
	}
	writer := l.(interface {
		CheckWriter() error
		WriterLost() <-chan struct{}
	})
	select {
	case <-writer.WriterLost():
		t.Fatal("writer lost while unrelated reply was blocked")
	case status := <-renewed:
		if status != http.StatusOK {
			t.Fatalf("renewal returned HTTP %d while unrelated reply was blocked", status)
		}
		if err := writer.CheckWriter(); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("renewal neither completed nor reported loss")
	}
}

type stalledResponse struct {
	http.ResponseWriter
	stalled, release chan struct{}
}

func (w stalledResponse) Write(b []byte) (int, error) {
	close(w.stalled)
	<-w.release
	return w.ResponseWriter.Write(b)
}
