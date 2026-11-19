package modular

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"

	acp "github.com/caelis-labs/acp-go-sdk"
)

type testACPClient struct {
	mu      sync.Mutex
	updates []acp.SessionNotification
}

func (c *testACPClient) SessionUpdate(_ context.Context, p acp.SessionNotification) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.updates = append(c.updates, p)
	return nil
}
func (c *testACPClient) RequestPermission(context.Context, acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{Outcome: "cancelled"}}}, nil
}
func TestServeACP(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	project := t.TempDir()
	p := Provider{ID: "acp-test", Models: func() []ModelInfo {
		return []ModelInfo{{ModelRef: ModelRef{Provider: "acp-test", ID: "offline"}, ContextWindow: 4000, MaxOutput: 2000}}
	}, Request: func(_ context.Context, _ ModelRef, _ ModelRequest, c *ProviderContext) (AssistantMessage, error) {
		c.Piece("text", "Hello ACP.")
		return AssistantMessage{Content: Text("Hello ACP."), Stop: "finished"}, nil
	}}
	a, err := New(t.Context(), WithProject(project), WithPluginHost(true), WithProvider(p))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	agentSide, clientSide := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- a.serveACP(t.Context(), agentSide, agentSide) }()
	client := &testACPClient{}
	conn := acp.NewClientSideConnection(client, clientSide, clientSide)
	defer func() {
		_ = conn.Close()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	if _, err = conn.Initialize(t.Context(), acp.InitializeRequest{ProtocolVersion: 1}); err != nil {
		t.Fatal(err)
	}
	session, err := conn.NewSession(t.Context(), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
	if err != nil {
		t.Fatal(err)
	}
	turn, err := conn.Prompt(t.Context(), acp.PromptRequest{SessionId: session.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("Say hello.")}})
	if err != nil || turn.StopReason != acp.StopReasonEndTurn {
		t.Fatalf("turn: %#v, %v", turn, err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	data, _ := json.Marshal(client.updates)
	if !strings.Contains(string(data), "Hello ACP.") {
		t.Fatalf("updates: %s", data)
	}
}
