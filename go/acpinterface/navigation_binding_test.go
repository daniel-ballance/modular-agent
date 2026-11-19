package acpinterface_test

import (
	"encoding/json"
	"modular/api"
	"modular/fake"
	"modular/internal/runtimetest"
	"strings"
	"testing"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestACPBindingNavigationAndOptionalMethods(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Text("first"), Stop: "finished"}}, fake.Script{Response: api.Response{Content: api.Text("second"), Stop: "finished"}})
		a := compose(t, root, p)
		conn, _ := connection(t, a, &client{})
		initClient(t, conn, false)
		s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		extension := func(name string, params map[string]any) json.RawMessage {
			t.Helper()
			params["sessionId"] = s.SessionId
			raw, err := conn.CallExtension(timeout(t), "_modular-agent/"+name, params)
			if err != nil {
				t.Fatal(name, err)
			}
			return raw
		}
		prompt(t, conn, s.SessionId, "first", "")
		var branch struct{ Entries []map[string]any }
		json.Unmarshal(extension("history", map[string]any{}), &branch)
		end := branch.Entries[len(branch.Entries)-1]["id"].(string)
		prompt(t, conn, s.SessionId, "second", "")
		if raw := extension("jobs", map[string]any{}); string(raw) != `{"jobs":[]}` {
			t.Fatal(string(raw))
		}
		fork := api.Decode[map[string]string](extension("fork", map[string]any{"entryId": end}))["sessionId"]
		if fork == "" {
			t.Fatal("fork shape")
		}
		if _, err = conn.CloseSession(timeout(t), acp.CloseSessionRequest{SessionId: acp.SessionId(fork)}); err != nil {
			t.Fatal(err)
		}
		if raw := extension("move", map[string]any{"entryId": end}); string(raw) != `{}` {
			t.Fatal(string(raw))
		}
		if raw := extension("history", map[string]any{}); strings.Contains(string(raw), `"text":"second"`) {
			t.Fatal("history includes unselected branch", string(raw))
		}
		all := extension("history", map[string]any{"all": true})
		if !strings.Contains(string(all), `"text":"second"`) {
			t.Fatal("all omitted unselected entries", string(all))
		}
		json.Unmarshal(extension("history", map[string]any{}), &branch)
		input := ""
		for _, e := range branch.Entries {
			if e["kind"] == "input" {
				input = e["id"].(string)
			}
		}
		erased := api.Decode[map[string]any](extension("erase", map[string]any{"entryIds": []string{input}}))
		found := false
		for _, pair := range erased["erased"].([]any) {
			p := pair.(map[string]any)
			found = found || p["id"] == input && p["sessionId"] == string(s.SessionId)
		}
		if !found || erased["pending"] == nil || len(erased["outOfReach"].([]any)) == 0 {
			t.Fatal(erased)
		}
	})
}
