package historyhttp_test

import (
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type delayedReader struct {
	io.Reader
	delay time.Duration
}

func (r *delayedReader) Read(b []byte) (int, error) {
	if r.delay > 0 {
		time.Sleep(r.delay)
		r.delay = 0
	}
	return r.Reader.Read(b)
}
func TestLeaseIsCheckedAfterSlowRequestBody(t *testing.T) {
	s, err := historyhttp.New(t.TempDir(), 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	handler := s.Handler("token")
	call := func(method, path, body string, delay time.Duration, status int) map[string]any {
		t.Helper()
		req := httptest.NewRequest(method, path, &delayedReader{strings.NewReader(body), delay})
		req.Header.Set("Authorization", "Bearer token")
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	call("PUT", "/v1/sessions/test", `{"project":"/p","created":0}`, 0, 200)
	lease := call("POST", "/v1/sessions/test/lease", `{"owner":"one"}`, 0, 200)["lease"].(string)
	out := call("POST", "/v1/sessions/test/entries", `{"lease":"`+lease+`","entries":[{"id":"late","parentId":null}]}`, 100*time.Millisecond, 409)
	if out["code"] != "lost" {
		t.Fatal(out)
	}
	if len(call("GET", "/v1/sessions/test", "", 0, 200)["entries"].([]any)) != 0 {
		t.Fatal("late body committed")
	}
	call("POST", "/v1/sessions/test/lease", `{"owner":"one"}`, 0, 200)
	// Expiry while reading an acquisition body must not leave an old owner held.
	call("POST", "/v1/sessions/test/lease", `{"owner":"two"}`, 100*time.Millisecond, 200)
	// Expiry while reading an erasure body means there is no other current owner.
	call("POST", "/v1/sessions/test/erase", `{"entryIds":[]}`, 100*time.Millisecond, 200)
}
