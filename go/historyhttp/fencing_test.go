package historyhttp_test

import (
	"bytes"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestHistoryBindingContract(t *testing.T) {
	dir := t.TempDir()
	// The contract test does multiple fsyncs between renew and erase; allow for slow disks.
	const ttl = 3 * time.Second
	s, err := historyhttp.New(dir, ttl)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler("token"))
	defer ts.Close()
	defer func() { s.Close() }()
	call := func(method, path, body, token string, status int, code string) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		var out map[string]any
		if err = json.Unmarshal(b, &out); err != nil {
			t.Fatalf("non-JSON: %s", b)
		}
		if status != 200 && (out["error"] == nil || out["code"] == nil) {
			t.Fatalf("bad error envelope: %s", b)
		}
		if res.StatusCode != status || (code != "" && out["code"] != code) {
			t.Fatalf("%s %s: %d %s, want %d %s", method, path, res.StatusCode, b, status, code)
		}
		return out
	}
	for _, token := range []string{"", "wrong"} {
		call("GET", "/v1", "", token, 401, "unauthorized")
	}
	if call("GET", "/v1", "", "token", 200, "")["binding"] != historyhttp.Binding {
		t.Fatal("version")
	}
	call("GET", "/v1/sessions/missing", "", "token", 404, "unknown_session")
	call("PUT", "/v1/sessions/invalid", `{}`, "token", 400, "invalid_request")
	call("PUT", "/v1/sessions/odd%2Fid%3Fname", `{"project":"/p","created":0}`, "token", 200, "")
	if call("GET", "/v1/sessions/odd%2Fid%3Fname", "", "token", 200, "")["session"].(map[string]any)["id"] != "odd/id?name" {
		t.Fatal("escaped identity")
	}
	for _, q := range []struct{ id, project, created string }{{"one", "/p", "1"}, {"two", "/q", "3"}, {"empty", "/p", "4"}, {"three", "/p", "2"}} {
		body := `{"project":"` + q.project + `","created":` + q.created + `,"parentSessionId":"parent","forkedFrom":{"sessionId":"source","entryId":"fork"}}`
		call("PUT", "/v1/sessions/"+q.id, body, "token", 200, "")
		call("PUT", "/v1/sessions/"+q.id, body, "token", 200, "")
	}
	call("PUT", "/v1/sessions/one", `{"project":"different","created":1}`, "token", 409, "conflict")
	lease := call("POST", "/v1/sessions/one/lease", `{"owner":"first"}`, "token", 200, "")["lease"].(string)
	again := call("POST", "/v1/sessions/one/lease", `{"owner":"first"}`, "token", 200, "")["lease"]
	if again != lease {
		t.Fatal("acquire resend changed token")
	}
	needRetryAfter := func(out map[string]any) {
		t.Helper()
		if delay, ok := out["retryAfterMs"].(float64); !ok || delay <= 0 || delay > float64(ttl.Milliseconds()) {
			t.Fatalf("held did not declare time left on the lease: %v", out)
		}
	}
	needRetryAfter(call("POST", "/v1/sessions/one/lease", `{"owner":"second"}`, "token", 409, "held"))
	call("POST", "/v1/sessions/one/lease/"+lease+"/renew", "", "token", 200, "")
	entries := `[{"id":"a","parentId":null,"kind":"custom","turnId":"t","stepId":"s","toolCallId":"call","jobId":"j","actorId":"private","secret":"erase me","nested":{"z":[1,true,null],"a":2}},{"id":"b","parentId":"a","kind":"custom","arbitrary":"kept"}]`
	appendBody := `{"lease":"` + lease + `","entries":` + entries + `}`
	if call("POST", "/v1/sessions/one/entries", appendBody, "token", 200, "")["kept"] != float64(2) {
		t.Fatal("kept")
	}
	if call("POST", "/v1/sessions/one/entries", appendBody, "token", 200, "")["kept"] != float64(0) {
		t.Fatal("resend")
	}
	reordered := `{"lease":"` + lease + `","entries":[{"nested":{"a":2,"z":[1,true,null]},"secret":"erase me","actorId":"private","jobId":"j","toolCallId":"call","stepId":"s","turnId":"t","kind":"custom","parentId":null,"id":"a"}]}`
	call("POST", "/v1/sessions/one/entries", reordered, "token", 200, "")
	call("POST", "/v1/sessions/one/entries", strings.Replace(reordered, `"a":2,`, `"a":2.0,`, 1), "token", 200, "")
	before := call("GET", "/v1/sessions/one", "", "token", 200, "")
	var want any
	json.Unmarshal([]byte(entries), &want)
	if !reflect.DeepEqual(before["entries"], want) {
		t.Fatalf("opaque fields changed: %v", before)
	}
	if before["session"].(map[string]any)["parentSessionId"] != "parent" {
		t.Fatal("session metadata lost")
	}
	call("POST", "/v1/sessions/one/entries", `{"lease":"`+lease+`","entries":[{"id":"c","parentId":"b"},{"id":"a","parentId":null,"changed":true}]}`, "token", 409, "conflict")
	if !reflect.DeepEqual(before, call("GET", "/v1/sessions/one", "", "token", 200, "")) {
		t.Fatal("batch not atomic")
	}
	call("POST", "/v1/sessions/one/entries", `{"lease":"`+lease+`","entries":[{"id":"bad"}]}`, "token", 400, "invalid_request")
	if len(call("GET", "/v1/sessions/one?after=a", "", "token", 200, "")["entries"].([]any)) != 1 {
		t.Fatal("after")
	}
	call("GET", "/v1/sessions/one?after=missing", "", "token", 404, "unknown_entry")
	for _, id := range []string{"two", "three"} {
		l := call("POST", "/v1/sessions/"+id+"/lease", `{"owner":"writer"}`, "token", 200, "")["lease"].(string)
		call("POST", "/v1/sessions/"+id+"/entries", `{"lease":"`+l+`","entries":[{"id":"copy","parentId":null,"copies":["a"]}]}`, "token", 200, "")
	}
	listed := call("GET", "/v1/sessions", "", "token", 200, "")["sessions"].([]any)
	if len(listed) != 3 || listed[0].(map[string]any)["id"] != "two" || listed[1].(map[string]any)["id"] != "three" {
		t.Fatal("newest first/unused", listed)
	}
	if len(call("GET", "/v1/sessions?project=%2Fp", "", "token", 200, "")["sessions"].([]any)) != 2 {
		t.Fatal("project filter")
	}
	needRetryAfter(call("POST", "/v1/sessions/one/erase", `{"entryIds":["a"]}`, "token", 409, "held"))
	call("POST", "/v1/sessions/one/erase", `{"entryIds":["a"],"lease":"wrong"}`, "token", 409, "lost")
	for range 2 {
		call("POST", "/v1/sessions/one/erase", `{"entryIds":["a"],"lease":"`+lease+`"}`, "token", 200, "")
	}
	erased := call("GET", "/v1/sessions/one", "", "token", 200, "")["entries"].([]any)[0].(map[string]any)
	if len(erased) != 8 || erased["erased"] != true || erased["id"] != "a" || erased["kind"] != "custom" || erased["turnId"] != "t" || erased["stepId"] != "s" || erased["toolCallId"] != "call" || erased["jobId"] != "j" {
		t.Fatal("erasure remnant", erased)
	}
	if len(call("GET", "/v1/sessions/two", "", "token", 200, "")["entries"].([]any)[0].(map[string]any)) != 3 {
		t.Fatal("service followed copies")
	}
	for range 2 {
		call("DELETE", "/v1/sessions/one/lease/"+lease, "", "token", 200, "")
	}
	call("POST", "/v1/sessions/one/lease/"+lease+"/renew", "", "token", 409, "lost")
	call("POST", "/v1/sessions/one/entries", appendBody, "token", 409, "lost")
	next := call("POST", "/v1/sessions/one/lease", `{"owner":"second"}`, "token", 200, "")["lease"].(string)
	time.Sleep(ttl + 40*time.Millisecond)
	call("POST", "/v1/sessions/one/lease/"+next+"/renew", "", "token", 409, "lost")
	call("POST", "/v1/sessions/one/entries", `{"lease":"`+next+`","entries":[]}`, "token", 409, "lost")
	call("POST", "/v1/sessions/one/erase", `{"entryIds":["b"]}`, "token", 200, "")
	fresh := call("POST", "/v1/sessions/one/lease", `{"owner":"third"}`, "token", 200, "")["lease"].(string)
	call("DELETE", "/v1/sessions/one/lease/"+next, "", "token", 200, "")
	call("POST", "/v1/sessions/one/lease/"+fresh+"/renew", "", "token", 200, "")
	ts.Close()
	s.Close()
	pending := filepath.Join(dir, ".pending-crash")
	if err = os.WriteFile(pending, []byte("erase me"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err = historyhttp.New(dir, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ts = httptest.NewServer(s.Handler("token"))
	defer ts.Close()
	call("POST", "/v1/sessions/one/lease/"+fresh+"/renew", "", "token", 409, "lost")
	kept := call("GET", "/v1/sessions/one", "", "token", 200, "")
	if bytes.Contains(mustJSON(kept), []byte("erase me")) {
		t.Fatal("erasure not durable")
	}
	if _, err = os.Stat(pending); !os.IsNotExist(err) {
		t.Fatal("stale snapshot retained", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		b, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte("erase me")) {
			t.Fatal("erased payload retained on disk", file.Name())
		}
	}
	if len(kept["entries"].([]any)) != 2 {
		t.Fatal("restart lost entries")
	}
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
