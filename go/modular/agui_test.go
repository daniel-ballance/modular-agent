package modular_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

const testAGToken = "test-only-agui-credential"

func agActor(t *testing.T) modular.ACPActor {
	t.Helper()
	file := filepath.Join(t.TempDir(), "test.token")
	if err := os.WriteFile(file, []byte(testAGToken), 0600); err != nil {
		t.Fatal(err)
	}
	return modular.ACPActor{TokenFile: file, Actor: modular.LocalACPActor(), ClientID: "browser"}
}
func agPost(t *testing.T, url, body string, status int) string {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), "POST", url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testAGToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode != status {
		t.Fatalf("POST: HTTP %d: %s (%v)", res.StatusCode, b, err)
	}
	return string(b)
}
func agThread(t *testing.T, url string) string {
	t.Helper()
	var v struct{ ThreadID string }
	if err := json.Unmarshal([]byte(agPost(t, url+"/threads", "{}", 201)), &v); err != nil || v.ThreadID == "" {
		t.Fatalf("create thread: %v", err)
	}
	return v.ThreadID
}
func TestServeAGUIKeepsSessionAfterListenerClose(t *testing.T) {
	a := modulartest.Agent(t, modulartest.Script(`[{"text":"Hello."}]`))
	s, err := a.ServeAGUI(t.Context(), modular.ServeAGUIOptions{Listen: "127.0.0.1:0", Actors: []modular.ACPActor{agActor(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	url := strings.TrimRight(s.URL, "/") + "/agui/v1"
	id := agThread(t, url)
	result := agPost(t, url+"/run", fmt.Sprintf(`{"threadId":%q,"runId":"one","protocolVersion":"1.0","messages":[{"role":"user","id":"a","content":"Hi!"}]}`, id), 200)
	if !strings.Contains(result, `"type":"RUN_FINISHED"`) || !strings.Contains(result, `"content":"Hello."`) {
		t.Fatal(result)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	rows, err := a.Sessions(context.Background())
	if err != nil || len(rows) != 1 || rows[0].ID != id {
		t.Fatalf("listener close lost session: %v %v", rows, err)
	}
}
