package acpinterface_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/OWNER/modular-agent/go/acpinterface"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/vanilla"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"net/http/httptest"
)

type client struct {
	mu          sync.Mutex
	updates     []acp.SessionNotification
	events      []api.Event
	permission  func(context.Context, acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error)
	elicitation func(context.Context, acp.CreateElicitationRequest) (acp.CreateElicitationResponse, error)
}

func (c *client) SessionUpdate(_ context.Context, p acp.SessionNotification) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.updates = append(c.updates, p)
	return nil
}
func (c *client) RequestPermission(ctx context.Context, p acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	if c.permission != nil {
		return c.permission(ctx, p)
	}
	return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{Outcome: "cancelled"}}}, nil
}
func (c *client) CreateElicitation(ctx context.Context, p acp.CreateElicitationRequest) (acp.CreateElicitationResponse, error) {
	if c.elicitation != nil {
		return c.elicitation(ctx, p)
	}
	return acp.CreateElicitationResponse{Decline: &acp.CreateElicitationDecline{Action: "decline"}}, nil
}
func (c *client) HandleExtensionMethod(_ context.Context, method string, b json.RawMessage) (any, error) {
	if method != "_modular-agent/event" {
		return nil, acp.NewMethodNotFound(method)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, api.Decode[api.Event](b))
	return nil, nil
}
func (c *client) text() string { c.mu.Lock(); defer c.mu.Unlock(); return string(api.JSON(c.updates)) }
func (c *client) clear()       { c.mu.Lock(); defer c.mu.Unlock(); c.updates = nil; c.events = nil }
func timeout(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	return ctx
}
func connection(t *testing.T, a api.API, c *client) (*acp.ClientSideConnection, func()) {
	t.Helper()
	v, err := a.Get("interface.acp")
	if err != nil {
		t.Fatal(err)
	}
	agent, peer := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- v.(*acpinterface.Interface).Serve(ctx, agent, agent) }()
	conn := acp.NewClientSideConnection(c, peer, peer)
	var once sync.Once
	close := func() {
		once.Do(func() {
			conn.Close()
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Error(err)
				}
			case <-time.After(5 * time.Second):
				t.Error("ACP server did not stop")
			}
			conn.Wait(context.Background())
		})
	}
	t.Cleanup(close)
	return conn, close
}
func initClient(t *testing.T, conn *acp.ClientSideConnection, forms bool) acp.InitializeResponse {
	t.Helper()
	caps := acp.ClientCapabilities{Meta: map[string]json.RawMessage{acpinterface.Namespace: api.JSON(map[string]bool{"events": true})}}
	if forms {
		caps.Elicitation = &acp.ElicitationCapabilities{Form: &acp.ElicitationFormCapabilities{}}
	}
	out, err := conn.Initialize(timeout(t), acp.InitializeRequest{ProtocolVersion: 1, ClientCapabilities: caps})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func prompt(t *testing.T, conn *acp.ClientSideConnection, id acp.SessionId, text, key string) acp.PromptResponse {
	t.Helper()
	p := acp.PromptRequest{SessionId: id, Prompt: []acp.ContentBlock{acp.TextBlock(text)}}
	if key != "" {
		p.Meta = map[string]json.RawMessage{acpinterface.Namespace: api.JSON(map[string]string{"key": key})}
	}
	out, err := conn.Prompt(timeout(t), p)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func compose(t *testing.T, project string, p *fake.Provider) api.API {
	t.Helper()
	h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Project: project, Provider: p.Plugin(), Model: "fake", Runtime: runtimetest.Plugin(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	return h.API()
}
func TestACPLifecycleConfigReplayAndKeys(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		project := t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Text("first cobalt"), Stop: "finished"}}, fake.Script{Require: "first cobalt", Response: api.Response{Content: api.Text("continued cobalt"), Stop: "finished"}})
		a := compose(t, project, p)
		c := &client{}
		conn, close := connection(t, a, c)
		if _, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}}); err == nil {
			t.Fatal("new before initialization accepted")
		}
		declaration := initClient(t, conn, true)
		if declaration.ProtocolVersion != 1 || !declaration.AgentCapabilities.LoadSession || !declaration.AgentCapabilities.McpCapabilities.Http || declaration.AgentCapabilities.SessionCapabilities.List == nil || declaration.AgentCapabilities.SessionCapabilities.Resume == nil || declaration.AgentCapabilities.SessionCapabilities.Close == nil {
			t.Fatal(declaration)
		}
		start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		if len(start.ConfigOptions) != 3 || start.ConfigOptions[0].Select.CurrentValue != "fake/fake" {
			t.Fatal(start)
		}
		set, err := conn.SetSessionConfigOption(timeout(t), acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: start.SessionId, ConfigId: "thinking", Value: "high"}})
		if err != nil || len(set.ConfigOptions) != 3 || set.ConfigOptions[1].Select.CurrentValue != "high" {
			t.Fatal(set, err)
		}
		set, err = conn.SetSessionConfigOption(timeout(t), acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: start.SessionId, ConfigId: "model", Value: "fake/fake-alt"}})
		if err != nil || set.ConfigOptions[0].Select.CurrentValue != "fake/fake-alt" {
			t.Fatal(set, err)
		}
		if _, err = conn.SetSessionConfigOption(timeout(t), acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: start.SessionId, ConfigId: "model", Value: "not-offered"}}); err == nil {
			t.Fatal("unknown model accepted")
		}
		if _, err = conn.CallExtension(timeout(t), "_modular-agent/input", map[string]any{"sessionId": start.SessionId, "when": "whenever", "content": "invalid"}); err == nil {
			t.Fatal("unknown intake timing accepted")
		}
		out := prompt(t, conn, start.SessionId, "hello", "unique")
		if out.StopReason != acp.StopReasonEndTurn || !strings.Contains(c.text(), "first cobalt") {
			t.Fatal(out, c.text())
		}
		again := prompt(t, conn, start.SessionId, "retry changed bytes", "unique")
		if again.StopReason != out.StopReason || len(p.Requests()) != 1 {
			t.Fatal(again, p.Requests())
		}
		list, err := conn.ListSessions(timeout(t), acp.ListSessionsRequest{})
		if err != nil || len(list.Sessions) != 1 || list.Sessions[0].SessionId != start.SessionId {
			t.Fatal(list, err)
		}
		raw, err := conn.CallExtension(timeout(t), "_modular-agent/history", map[string]any{"sessionId": start.SessionId})
		if err != nil {
			t.Fatal(err)
		}
		var followed struct{ Entries []api.Entry }
		json.Unmarshal(raw, &followed)
		if len(followed.Entries) == 0 {
			t.Fatal(string(raw))
		}
		cursor := followed.Entries[len(followed.Entries)-1].ID
		snap, _ := a.Snapshot(string(start.SessionId))
		if snap.Actors["local-user"].Kind != "host" {
			t.Fatal(snap.Actors)
		}
		close()
		c = &client{}
		conn, close = connection(t, a, c)
		defer close()
		initClient(t, conn, true)
		loaded, err := conn.LoadSession(timeout(t), acp.LoadSessionRequest{SessionId: start.SessionId, Cwd: project, McpServers: []acp.McpServer{}})
		if err != nil || len(loaded.ConfigOptions) != 3 || !strings.Contains(c.text(), "first cobalt") || !strings.Contains(c.text(), "hello") {
			t.Fatal(loaded, err, c.text())
		}
		c.clear()
		prompt(t, conn, start.SessionId, "continue", "")
		raw, err = conn.CallExtension(timeout(t), "_modular-agent/history", map[string]any{"sessionId": start.SessionId, "after": cursor})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), `"text":"hello"`) || !strings.Contains(string(raw), "continued cobalt") {
			t.Fatal(string(raw))
		}
		if _, err = conn.CloseSession(timeout(t), acp.CloseSessionRequest{SessionId: start.SessionId}); err != nil {
			t.Fatal(err)
		}
		c.clear()
		resumed, err := conn.ResumeSession(timeout(t), acp.ResumeSessionRequest{SessionId: start.SessionId, Cwd: project, McpServers: []acp.McpServer{}})
		if err != nil || len(resumed.ConfigOptions) != 3 || strings.Contains(c.text(), "continued cobalt") {
			t.Fatal(resumed, err, c.text())
		}
		if _, err = conn.Prompt(timeout(t), acp.PromptRequest{SessionId: "unattached", Prompt: []acp.ContentBlock{acp.TextBlock("no")}}); err == nil {
			t.Fatal("unattached session driven")
		}
		if _, err = conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: t.TempDir(), McpServers: []acp.McpServer{}}); err == nil {
			t.Fatal("different project accepted")
		}
		if _, err = conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, AdditionalDirectories: []string{t.TempDir()}, McpServers: []acp.McpServer{}}); err == nil {
			t.Fatal("unsupported roots accepted")
		}
	})
}
func call(id, name string, args any) api.Part {
	return api.Part{Type: "tool_call", Call: &api.Call{ID: id, Name: name, Input: api.JSON(args)}}
}
func TestACPPermissionsAndElicitation(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, choice := range []string{"allow", "refuse", "cancelled", "invalid"} {
			t.Run(choice, func(t *testing.T) {
				project := t.TempDir()
				p := fake.New(fake.Script{Response: api.Response{Content: api.Content{call("write", "write", map[string]string{"path": "answer.txt", "content": "cobalt"})}, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("finished"), Stop: "finished"}})
				a := compose(t, project, p)
				asked := 0
				c := &client{permission: func(ctx context.Context, q acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
					asked++
					if len(q.Options) != 2 || q.Options[0].Kind != acp.PermissionOptionKindAllowOnce || q.ToolCall.ToolCallId != "write" {
						return acp.RequestPermissionResponse{}, fmt.Errorf("invalid permission mapping: %v", q)
					}
					if choice == "cancelled" {
						return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{Outcome: "cancelled"}}}, nil
					}
					return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{Outcome: "selected", OptionId: acp.PermissionOptionId(choice)}}}, nil
				}}
				conn, _ := connection(t, a, c)
				initClient(t, conn, true)
				start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
				if err != nil {
					t.Fatal(err)
				}
				_, err = conn.SetSessionConfigOption(timeout(t), acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: start.SessionId, ConfigId: "approval", Value: "all"}})
				if err != nil {
					t.Fatal(err)
				}
				prompt(t, conn, start.SessionId, "write", "")
				if asked != 1 {
					t.Fatal("permission not requested", asked)
				}
				_, err = os.Stat(filepath.Join(project, "answer.txt"))
				if (err == nil) != (choice == "allow") {
					t.Fatal("permission did not fail closed", choice, err)
				}
				snap, _ := a.Snapshot(string(start.SessionId))
				for _, e := range snap.Entries {
					if e.Kind == "tool.result" {
						r := api.Decode[api.ToolResult](e.Data)
						want := "refused"
						if choice == "allow" {
							want = "completed"
						}
						if r.Status != want {
							t.Fatal(r)
						}
					}
				}
			})
		}
		for _, kind := range []string{"text", "choice", "secret"} {
			t.Run(kind, func(t *testing.T) {
				project := t.TempDir()
				p := fake.New(fake.Script{Response: api.Response{Content: api.Content{call("ask", "ask_user", map[string]any{"kind": kind, "question": "Choose a color", "options": []string{"cobalt", "ochre"}, "credential": "test-secret"})}, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("thanks"), Stop: "finished"}})
				a := compose(t, project, p)
				asked := 0
				c := &client{elicitation: func(_ context.Context, q acp.CreateElicitationRequest) (acp.CreateElicitationResponse, error) {
					asked++
					if q.Form == nil || q.Form.Mode != "form" || q.Form.SessionId == nil || len(q.Form.RequestedSchema.Required) != 1 {
						t.Error("bad elicitation", q)
					}
					return acp.CreateElicitationResponse{Accept: &acp.CreateElicitationAccept{Action: "accept", Content: map[string]any{"answer": "cobalt"}}}, nil
				}}
				conn, _ := connection(t, a, c)
				initClient(t, conn, true)
				start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
				if err != nil {
					t.Fatal(err)
				}
				prompt(t, conn, start.SessionId, "ask", "")
				if kind == "secret" {
					if asked != 0 {
						t.Fatal("secret sent in form")
					}
				} else {
					if asked != 1 || !strings.Contains(string(api.JSON(p.Requests())), "cobalt") {
						t.Fatal(asked, p.Requests())
					}
				}
			})
		}
	})
}
func TestACPElicitationDeclinesAndValidates(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, scenario := range []string{"decline", "cancel", "wrong-type", "wrong-choice"} {
			t.Run(scenario, func(t *testing.T) {
				root := t.TempDir()
				p := fake.New(fake.Script{Response: api.Response{Content: api.Content{call("ask", "ask_user", map[string]any{"kind": "choice", "question": "Color?", "options": []string{"cobalt"}})}, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("done"), Stop: "finished"}})
				a := compose(t, root, p)
				count := 0
				c := &client{elicitation: func(context.Context, acp.CreateElicitationRequest) (acp.CreateElicitationResponse, error) {
					count++
					switch scenario {
					case "decline":
						return acp.CreateElicitationResponse{Decline: &acp.CreateElicitationDecline{Action: "decline"}}, nil
					case "cancel":
						return acp.CreateElicitationResponse{Cancel: &acp.CreateElicitationCancel{Action: "cancel"}}, nil
					}
					value := any(42)
					if scenario == "wrong-choice" {
						value = "not-an-option"
					}
					return acp.CreateElicitationResponse{Accept: &acp.CreateElicitationAccept{Action: "accept", Content: map[string]any{"answer": value}}}, nil
				}}
				conn, _ := connection(t, a, c)
				initClient(t, conn, scenario != "unsupported")
				start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
				if err != nil {
					t.Fatal(err)
				}
				prompt(t, conn, start.SessionId, "ask", "")
				if scenario == "unsupported" && count != 0 {
					t.Fatal("unadvertised form called")
				}
				snap, _ := a.Snapshot(string(start.SessionId))
				answered := false
				for _, e := range snap.Entries {
					if e.Kind == "question.answer" {
						answered = true
						if !api.Decode[api.Answer](e.Data).Declined {
							t.Fatal("invalid elicitation accepted", e)
						}
					}
				}
				if !answered {
					t.Fatal("no decline recorded")
				}
			})
		}
	})
}
func TestACPCancelAndGate(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		started := make(chan struct{})
		p := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, emit func(api.Part)) (api.Response, error) {
			close(started)
			<-ctx.Done()
			return api.Response{}, ctx.Err()
		}})
		a := compose(t, root, p)
		c := &client{}
		conn, _ := connection(t, a, c)
		initClient(t, conn, false)
		start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			out, err := conn.Prompt(timeout(t), acp.PromptRequest{SessionId: start.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("wait")}})
			if err == nil && out.StopReason != acp.StopReasonCancelled {
				err = fmt.Errorf("not cancelled: %v", out)
			}
			done <- err
		}()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("model not started")
		}
		if err = conn.Cancel(timeout(t), acp.CancelNotification{SessionId: start.SessionId}); err != nil {
			t.Fatal(err)
		}
		select {
		case err = <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("cancel stuck")
		}
	})
}
func TestACPMCPClientServersAreSessionScoped(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		remote := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
		mcp.AddTool(remote, &mcp.Tool{Name: "fact", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "cobalt-73"}}}, nil, nil
		})
		handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return remote }, nil)
		httpServer := httptest.NewServer(handler)
		defer httpServer.Close()
		root := t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Content{call("fact", "mcp_client__fact", map[string]any{})}, Stop: "tools"}}, fake.Script{Require: "cobalt-73", Response: api.Response{Content: api.Text("verified MCP"), Stop: "finished"}})
		a := compose(t, root, p)
		c := &client{}
		conn, close := connection(t, a, c)
		defer close()
		initClient(t, conn, false)
		spec := api.Decode[acp.McpServer](api.JSON(map[string]any{"type": "http", "name": "client", "url": httpServer.URL, "headers": []any{}}))
		start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{spec}})
		if err != nil {
			t.Fatal(err)
		}
		other, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		prompt(t, conn, start.SessionId, "fact", "")
		if !strings.Contains(c.text(), "verified MCP") {
			t.Fatal(c.text())
		}
		raw, err := conn.CallExtension(timeout(t), "_modular-agent/call_tool", map[string]any{"sessionId": other.SessionId, "call": api.Call{Name: "mcp_client__fact", Input: api.JSON(map[string]any{})}})
		if err != nil {
			t.Fatal(err)
		}
		r := api.Decode[api.ToolResult](raw)
		if r.Status == "completed" {
			t.Fatal("MCP tool leaked", r)
		}
		if _, err = conn.CloseSession(timeout(t), acp.CloseSessionRequest{SessionId: start.SessionId}); err != nil {
			t.Fatal(err)
		}
	})
}
