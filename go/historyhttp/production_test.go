package historyhttp_test

import (
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHistoryValidationAndExactOpaqueDecimals(t *testing.T) {
	s, err := historyhttp.New(t.TempDir(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	const token = "test"
	h := s.Handler(token)
	call := func(method, path, body string, status int, code string) map[string]any {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var result map[string]any
		d := json.NewDecoder(w.Body)
		d.UseNumber()
		responseBody := w.Body.String()
		if err := d.Decode(&result); err != nil || w.Code != status || code != "" && result["code"] != code {
			t.Fatalf("%s %s: got %d %s, want %d %s", method, path, w.Code, responseBody, status, code)
		}
		return result
	}
	const path = "/v1/sessions/test"
	for _, body := range []string{
		`{"project":"/p","created":null}`, `{"project":"/p","created":0,"id":null}`,
		`{"project":"/p","created":9007199254740991.1}`, `{"project":"/p","created":0,"unknown":{"a":1,"\u0061":2}}`,
		`{"project":"\ud800","created":0}`, `{"project":"/p","created":0,"parentSessionId":null}`,
	} {
		call("PUT", path, body, 400, "invalid_request")
	}
	call("GET", path, "", 404, "unknown_session")
	const meta = `{"project":"/p+q","created":0,"extra":1e9007199254740992}`
	call("PUT", path, meta, 200, "")
	call("PUT", path, strings.ReplaceAll(meta, "1e9007199254740992", "10e9007199254740991"), 200, "")
	call("PUT", path, strings.ReplaceAll(meta, "1e9007199254740992", "1e9007199254740993"), 409, "conflict")
	call("GET", path, `null`, 400, "invalid_request")
	call("POST", path, "", 405, "method_not_allowed")
	lease := call("POST", path+"/lease", `{"owner":"one"}`, 200, "")["lease"].(string)
	call("POST", path+"/entries", `{"lease":"`+lease+`","entries":[{"id":"entry","parentId":null}]}`, 200, "")
	if got := call("GET", "/v1/sessions?project=%2Fp+q", "", 200, ""); len(got["sessions"].([]any)) != 1 {
		t.Fatal("literal plus in query was not preserved")
	}
}
