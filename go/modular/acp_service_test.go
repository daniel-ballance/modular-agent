package modular

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
	"github.com/gorilla/websocket"
)

func TestACPServiceTokenSelectsIndependentScopedPrincipal(t *testing.T) {
	t.Setenv("MODULAR_AGENT_ACTOR", "not-the-network-actor")
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	project := t.TempDir()
	a, err := New(t.Context(), WithPluginHost(true), WithProject(project), WithConformanceFixtures())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	first := ACPActor{Actor: Actor{ID: "operator", Kind: "user", Rights: []string{"watch", "input"}}, Projects: []string{project}}
	second := ACPActor{Actor: Actor{ID: "viewer", Kind: "program", Rights: []string{"watch"}}, Projects: []string{t.TempDir()}}
	reader := ACPActor{Actor: Actor{ID: first.Actor.ID, Kind: first.Actor.Kind, Rights: []string{"watch"}}, Tenants: []string{""}}
	tokens := []string{"test-39560e6e6e8e721d16cb7ccae", "test-ad31380e279ba7499881804de", "test-0fa82446bdc4ab175e7ad941"}
	for i, entry := range []*ACPActor{&first, &second, &reader} {
		entry.TokenFile = filepath.Join(t.TempDir(), "token")
		if err := os.WriteFile(entry.TokenFile, []byte(tokens[i]), 0600); err != nil {
			t.Fatal(err)
		}
	}
	svc, err := a.ListenACP(t.Context(), ServeACPOptions{Listen: "127.0.0.1:0", Actors: []ACPActor{first, second, reader}})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	d := websocket.Dialer{Subprotocols: []string{wswire.ACP}}
	dial := func(i int) *websocket.Conn {
		c, _, err := d.DialContext(t.Context(), svc.URL, http.Header{"Authorization": {"Bearer " + tokens[i]}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		return c
	}
	call := func(c *websocket.Conn, msg string) map[string]any {
		t.Helper()
		if err := c.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
			t.Fatal(err)
		}
		var request struct{ ID float64 }
		if err := json.Unmarshal([]byte(msg), &request); err != nil {
			t.Fatal(err)
		}
		for {
			_, b, err := c.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			if m["id"] == request.ID {
				return m
			}
		}
	}
	one, two := dial(0), dial(1)
	for i, c := range []*websocket.Conn{one, two} {
		ping := `{"jsonrpc":"2.0","id":9,"method":"$/ping","params":{}}`
		if result, ok := call(c, ping)["result"].(map[string]any); !ok || len(result) != 0 {
			t.Fatalf("ping: %v", result)
		}
		msg := call(c, "{\n\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}\n}")
		if result, ok := call(c, ping)["result"].(map[string]any); !ok || len(result) != 0 {
			t.Fatalf("ping: %v", result)
		}
		want := []Actor{first.Actor, second.Actor}[i]
		var got struct {
			Result struct {
				Meta map[string]struct{ Actor Actor } `json:"_meta"`
			}
		}
		if err := decodeInto(msg, &got); err != nil {
			t.Fatal(err)
		}
		if act := got.Result.Meta["modular-agent"].Actor; act.ID != want.ID || act.Kind != want.Kind || len(act.Rights) != len(want.Rights) {
			t.Fatalf("actor = %+v, want %+v", act, want)
		}
	}
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": project, "mcpServers": []any{}}})
	if got := call(two, string(req)); got["error"] == nil {
		t.Fatalf("out-of-scope new succeeded: %v", got)
	}
	got := call(one, string(req))
	result, ok := got["result"].(map[string]any)
	if !ok {
		t.Fatalf("in-scope new refused: %v", got)
	}
	id := result["sessionId"].(string)
	watch := dial(2)
	if got := call(watch, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}`); got["error"] != nil {
		t.Fatal(got)
	}
	wire := func(method string, id int, params map[string]any) string {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		return string(b)
	}
	prompt := map[string]any{"sessionId": id, "prompt": []map[string]any{{"type": "text", "text": "Test prompt."}}}
	if got := call(one, wire("session/prompt", 3, prompt)); got["result"] == nil {
		t.Fatalf("owner could not commit its first turn: %v", got)
	}
	if got := call(watch, wire("session/resume", 2, map[string]any{"sessionId": id, "cwd": project, "mcpServers": []any{}})); got["result"] == nil {
		t.Fatalf("narrow token could not resume a broader recorded grant: %v", got)
	}
	if got := call(watch, wire("session/prompt", 3, map[string]any{"sessionId": id, "prompt": []map[string]any{{"type": "text", "text": "must not run"}}})); got["error"] == nil {
		t.Fatalf("watch-only connection prompted: %v", got)
	}
	if got := call(one, wire("session/prompt", 4, prompt)); got["result"] == nil {
		t.Fatalf("narrow token changed the owner's authority: %v", got)
	}
}
