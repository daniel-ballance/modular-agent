package servicehttp_test

import (
	"context"
	"modular/servicehttp"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestTransportRetriesOnlyDeclaredKeyedOperations(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		servicehttp.JSON(w, map[string]bool{"ok": true})
	}))
	defer ts.Close()
	c := servicehttp.NewClient(ts.URL, "token")
	var out map[string]bool
	if err := c.Call(context.Background(), "/new", "", struct{}{}, &out); err == nil || calls.Load() != 1 {
		t.Fatal("unkeyed operation repeated", err, calls.Load())
	}
	calls.Store(0)
	if err := c.Call(context.Background(), "/input", "stable-key", struct{}{}, &out); err != nil || calls.Load() != 2 || !out["ok"] {
		t.Fatal("keyed retry failed", err, calls.Load())
	}
	// Redirects never forward the bearer token to a second endpoint.
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, ts.URL, 307) }))
	defer redirect.Close()
	calls.Store(0)
	if _, err := servicehttp.NewClient(redirect.URL, "token").Open(context.Background(), "/", "", struct{}{}); err == nil || calls.Load() != 0 {
		t.Fatal("redirect followed", err)
	}
	if _, err := servicehttp.NewClient("http://192.0.2.1", "token").Open(context.Background(), "/", "", struct{}{}); err == nil {
		t.Fatal("non-loopback plaintext accepted")
	}
}
