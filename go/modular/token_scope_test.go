package modular_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/gorilla/websocket"
)

func acpSocket(t *testing.T, url, token string) func(string, map[string]any) map[string]any {
	t.Helper()
	d := websocket.Dialer{Subprotocols: []string{"modular-agent-acp-1"}}
	c, _, err := d.DialContext(t.Context(), url, http.Header{"Authorization": {"Bearer " + token}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	id := 0
	call := func(method string, p map[string]any) map[string]any {
		t.Helper()
		id++
		if err := c.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": p}); err != nil {
			t.Fatal(err)
		}
		for {
			var reply map[string]any
			if err := c.ReadJSON(&reply); err != nil {
				t.Fatal(err)
			}
			if reply["id"] == float64(id) {
				return reply
			}
		}
	}
	if reply := call("initialize", map[string]any{"protocolVersion": 1}); reply["error"] != nil {
		t.Fatal(reply)
	}
	return call
}

func TestACPTokenScopeEdges(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	root := t.TempDir()
	child := filepath.Join(root, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	tenant := modular.Tenant{Rights: []string{"watch", "input"}}
	build := func(ctx context.Context, project string) (*modular.Agent, error) {
		return modular.New(ctx, modular.WithProject(project), modular.WithPluginHost(true), modular.WithTenants(map[string]modular.Tenant{"team": tenant}))
	}
	a, err := build(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(ctx)
	for _, tc := range []struct {
		name              string
		projects, tenants []string
		project, tenant   string
		compose, allow    bool
	}{
		{name: "omitted tenants allow no tenant", project: root, allow: true},
		{name: "omitted tenants forbid a named tenant", project: root, tenant: "team"},
		{name: "explicit null allows no tenant", project: root, tenants: []string{""}, allow: true},
		{name: "explicit names exclude no tenant", project: root, tenants: []string{"team"}},
		{name: "explicit name allows named tenant", project: root, tenant: "team", tenants: []string{"team"}, allow: true},
		{name: "empty tenants allow none", project: root, tenants: []string{}},
		{name: "exact project allows root", project: root, projects: []string{root}, compose: true, allow: true},
		{name: "exact project forbids child", project: child, projects: []string{root}, compose: true},
		{name: "omitted projects honor fixed project", project: child},
		{name: "omitted projects honor composed project", project: child, compose: true, allow: true},
		{name: "empty projects allow none", project: root, projects: []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := "offline-acp-scope-test-128-bit"
			file := filepath.Join(t.TempDir(), "token")
			if err := os.WriteFile(file, []byte(token), 0600); err != nil {
				t.Fatal(err)
			}
			op := modular.ServeACPOptions{Listen: "127.0.0.1:0", Actors: []modular.ACPActor{{TokenFile: file, Actor: modular.Actor{ID: "operator", Kind: "user", Rights: []string{"watch", "input"}}, Projects: tc.projects, Tenants: tc.tenants}}}
			if tc.compose {
				op.Compose = build
			}
			svc, err := a.ListenACP(t.Context(), op)
			if err != nil {
				t.Fatal(err)
			}
			defer svc.Close()
			call := acpSocket(t, svc.URL, token)
			p := map[string]any{"cwd": tc.project, "mcpServers": []any{}}
			if tc.tenant != "" {
				p["_meta"] = map[string]any{"modular-agent": map[string]any{"tenant": tc.tenant}}
			}
			result := call("session/new", p)
			if (result["result"] != nil) != tc.allow {
				t.Fatalf("allow=%v: %+v", tc.allow, result)
			}
		})
	}
}
