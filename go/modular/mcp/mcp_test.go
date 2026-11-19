package mcp_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/OWNER/modular-agent/go/modular"
	tools "github.com/OWNER/modular-agent/go/modular/mcp"
	"github.com/OWNER/modular-agent/go/modular/modulartest"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestStreamableHTTPStartsOnlyValidServers(t *testing.T) {
	newServer := func(invalid bool) *httptest.Server {
		s := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
		type input struct {
			Text string `json:"text"`
		}
		mcp.AddTool(s, &mcp.Tool{Name: "echo", Description: "Echo a fixture."}, func(_ context.Context, _ *mcp.CallToolRequest, in input) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "echo: " + in.Text}}}, nil, nil
		})
		if invalid {
			mcp.AddTool(s, &mcp.Tool{Name: strings.Repeat("x", 65), Description: "Unrepresentable tool name."}, func(_ context.Context, _ *mcp.CallToolRequest, _ input) (*mcp.CallToolResult, any, error) {
				return nil, nil, fmt.Errorf("unexpected call")
			})
		}
		handle := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, nil)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Fixture") != "yes" {
				t.Error("missing configured header")
			}
			handle.ServeHTTP(w, r)
		}))
		t.Cleanup(server.Close)
		return server
	}
	good, bad := newServer(false), newServer(true)
	var warnings []string
	a := modulartest.Agent(t, tools.WithServers([]tools.Server{{Name: "bad", URL: bad.URL, Headers: map[string]string{"X-Fixture": "yes"}}, {Name: "fixture", URL: good.URL, Headers: map[string]string{"X-Fixture": "yes"}}, {Name: "missing", Command: "/not-an-installed-mcp-program"}}, func(err error) { warnings = append(warnings, err.Error()) }), modulartest.Script(`[{"toolCalls":[{"name":"mcp_fixture__echo","input":{"text":"harbour"}}]},{"text":"ok"}]`))
	if len(warnings) != 2 || !strings.Contains(warnings[0], "bad") || !strings.Contains(warnings[1], "missing") {
		t.Fatal(warnings)
	}
	session, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defs, err := a.ToolCatalog(session.ID())
	defs = slices.DeleteFunc(defs, func(d modular.ToolDefinition) bool { return !strings.HasPrefix(d.Name, "mcp_") })
	if err != nil || len(defs) != 1 || defs[0].Name != "mcp_fixture__echo" {
		t.Fatal(defs, err)
	}
	res, err := session.Prompt(t.Context(), "Echo.")
	if err != nil {
		t.Fatal(err)
	}
	rs := res.ToolResults()
	if len(rs) != 1 || rs[0].Status != modular.Completed || rs[0].Text() != "echo: harbour" {
		t.Fatal(rs)
	}
}
