package modular_test

import (
	"context"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type guideACPClient struct {
	mu   sync.Mutex
	text strings.Builder
}

func (c *guideACPClient) SessionUpdate(_ context.Context, n acp.SessionNotification) error {
	if chunk := n.Update.AgentMessageChunk; chunk != nil && chunk.Content.Text != nil {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.text.WriteString(chunk.Content.Text.Text)
	}
	return nil
}

func (*guideACPClient) RequestPermission(context.Context, acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{
		Cancelled: &acp.RequestPermissionOutcomeCancelled{Outcome: "cancelled"},
	}}, nil
}

func TestDriveOneACPPrompt(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	project, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	agent := modulartest.Agent(t, modular.WithProject(project), modular.WithPluginHost(true),
		modulartest.Script(`[{"text":"Hello over ACP."}]`))
	serverSide, clientSide := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- agent.ServeACP(ctx, modular.ServeACPOptions{Input: serverSide, Output: serverSide})
	}()
	client := &guideACPClient{}
	conn := acp.NewClientSideConnection(client, clientSide, clientSide)
	defer func() {
		_ = conn.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-ctx.Done():
			t.Error("ACP did not shut down:", ctx.Err())
		}
	}()

	if _, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1}); err != nil {
		t.Fatal(err)
	}
	session, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
	if err != nil {
		t.Fatal(err)
	}
	reply, err := conn.Prompt(ctx, acp.PromptRequest{
		SessionId: session.SessionId,
		Prompt:    []acp.ContentBlock{acp.TextBlock("Say hello.")},
	})
	if err != nil || reply.StopReason != acp.StopReasonEndTurn {
		t.Fatalf("prompt: %+v, %v", reply, err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if got := client.text.String(); got != "Hello over ACP." {
		t.Fatalf("streamed %q", got)
	}
}
