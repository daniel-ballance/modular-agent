package gateway_test

import (
	"context"
	"errors"
	"modular/api"
	"modular/fake"
	"modular/gateway"
	"modular/servicehttp"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGatewayDisconnectCancelsVendorAndNeverRetriesGeneration(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	p := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, emit func(api.Part)) (api.Response, error) {
		close(started)
		emit(api.Part{Type: "text", Text: "piece"})
		<-ctx.Done()
		close(cancelled)
		return api.Response{}, ctx.Err()
	}})
	ts := httptest.NewServer(gateway.New(p).Handler("token"))
	defer ts.Close()
	c, err := gateway.NewClient(servicehttp.NewClient(ts.URL, "token"))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := c.Access("fake")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := a.Generate(ctx, api.Request{}, nil); done <- err }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("vendor not called")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("vendor not cancelled")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("lost request succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("client not cancelled")
	}
	if len(p.Requests()) != 1 {
		t.Fatal("generation repeated")
	}
}
func TestLostGatewayAnswerIsUnknownNotRetried(t *testing.T) {
	p := fake.New(fake.Script{Response: api.Response{Content: api.Text("done")}})
	g := gateway.New(p).Handler("token")
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/model/generate" {
			g.ServeHTTP(httptest.NewRecorder(), r)
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		g.ServeHTTP(w, r)
	}))
	defer ts.Close()
	c, err := gateway.NewClient(servicehttp.NewClient(ts.URL, "token"))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := c.Access("fake")
	_, err = a.Generate(context.Background(), api.Request{}, nil)
	if err == nil || len(p.Requests()) != 1 {
		t.Fatal("lost answer retried", err)
	}
	// No complete response means the Runtime cannot claim a successful model request.
	if errors.Is(err, api.ErrUnknownOutcome) {
		return
	}
	// Failure before even the HTTP response is also an unknown request outcome.
	t.Fatal("lost header did not preserve unknown outcome", err)
}
