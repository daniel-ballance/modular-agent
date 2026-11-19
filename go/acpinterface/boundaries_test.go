package acpinterface_test

import (
	"context"
	"errors"
	"fmt"
	"modular/api"
	"modular/fake"
	"modular/internal/runtimetest"
	"modular/vanilla"
	"os"
	"strings"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestACPOutputGateCoversStreamReplayAndDuplicate(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		project := t.TempDir()
		p := fake.New(fake.Script{Chunks: []api.Part{{Type: "text", Text: "co"}, {Type: "text", Text: "balt"}}, Response: api.Response{Content: api.Text("cobalt"), Stop: "finished"}})
		h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Project: project, Model: "fake", Provider: p.Plugin(), Runtime: runtimetest.Plugin(t), Secrets: []string{"cobalt"}})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		c := &client{}
		conn, close := connection(t, h.API(), c)
		defer close()
		initClient(t, conn, true)
		start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		out := prompt(t, conn, start.SessionId, "hello", "once")
		if strings.Contains(string(api.JSON(out)), "cobalt") || strings.Contains(c.text(), "cobalt") || !strings.Contains(c.text(), "[REDACTED]") {
			t.Fatal(out, c.text())
		}
		out = prompt(t, conn, start.SessionId, "resend", "once")
		if strings.Contains(string(api.JSON(out)), "cobalt") {
			t.Fatal("duplicate leaked raw outcome", out)
		}
		raw, err := conn.CallExtension(timeout(t), "_modular-agent/history", map[string]any{"sessionId": start.SessionId})
		if err != nil || strings.Contains(string(raw), "cobalt") {
			t.Fatal(string(raw), err)
		}
		snap, _ := h.API().Snapshot(string(start.SessionId))
		if !strings.Contains(string(api.JSON(snap)), "cobalt") {
			t.Fatal("raw history was changed")
		}
		conn.CloseSession(timeout(t), acp.CloseSessionRequest{SessionId: start.SessionId})
		c.clear()
		if _, err = conn.LoadSession(timeout(t), acp.LoadSessionRequest{SessionId: start.SessionId, Cwd: project, McpServers: []acp.McpServer{}}); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(c.text(), "cobalt") || !strings.Contains(c.text(), "[REDACTED]") {
			t.Fatal("load leaked raw history", c.text())
		}
	})
}
func TestACPRepliesWhenOutputGateWithholdsAnAnswer(t *testing.T) {
	for _, method := range []struct{ name, event string }{{"requests", "interface.answer"}, {"answer", "interface.answer"}} {
		for _, mode := range []string{"block", "fail"} {
			t.Run(method.name+"/"+mode, func(t *testing.T) {
				const private = "private hook failure"
				project := t.TempDir()
				h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Project: project, Model: "fake", Provider: fake.New().Plugin()})
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				err = h.Load(api.Plugin{Name: "withhold-reply", Setup: func(a api.API) error {
					return a.Handle("output.batch", "", func(_ context.Context, v any) (api.Decision, error) {
						batch := v.(api.OutputBatch)
						if len(batch.Events) == 1 && batch.Events[0].Kind == method.event && (method.event != "interface.answer" || batch.Events[0].Method == "_modular-agent/"+method.name) {
							if mode == "fail" {
								return api.Decision{}, errors.New(private)
							}
							return api.Decision{Refuse: true}, nil
						}
						return api.Decision{}, nil
					})
				}})
				if err != nil {
					t.Fatal(err)
				}
				conn, close := connection(t, h.API(), &client{})
				defer close()
				initClient(t, conn, false)
				start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
				if err != nil {
					t.Fatal(err)
				}
				raw, err := conn.CallExtension(timeout(t), "_modular-agent/"+method.name, map[string]any{"sessionId": start.SessionId, "requestId": "unknown", "value": "x"})
				var rpc *acp.RequestError
				if len(raw) != 0 && string(raw) != "null" || !errors.As(err, &rpc) || rpc.Code != -32000 || !strings.Contains(rpc.Message, "output gate withheld") || api.Decode[map[string]string](api.JSON(rpc.Data))["code"] != "withheld" {
					t.Fatalf("expected only a withheld reply error, got %s, %v", raw, err)
				}
				if _, err := conn.CallExtension(timeout(t), "_modular-agent/history", map[string]any{"sessionId": start.SessionId}); err != nil {
					t.Fatalf("connection did not carry on after the error: %v", err)
				}
			})
		}
	}
}

func TestACPCancelsOutstandingPermission(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Content{call("write", "write", map[string]string{"path": "denied.txt", "content": "no"})}, Stop: "tools"}})
		a := compose(t, root, p)
		asked := make(chan struct{})
		cancelled := make(chan struct{})
		c := &client{permission: func(ctx context.Context, _ acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
			close(asked)
			<-ctx.Done()
			close(cancelled)
			return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{Outcome: "cancelled"}}}, nil
		}}
		conn, _ := connection(t, a, c)
		initClient(t, conn, false)
		start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		conn.SetSessionConfigOption(timeout(t), acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: start.SessionId, ConfigId: "approval", Value: "all"}})
		done := make(chan error, 1)
		go func() {
			out, err := conn.Prompt(timeout(t), acp.PromptRequest{SessionId: start.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("write")}})
			if err == nil && out.StopReason != acp.StopReasonCancelled {
				err = fmt.Errorf("not cancelled: %v", out)
			}
			done <- err
		}()
		select {
		case <-asked:
		case <-time.After(5 * time.Second):
			t.Fatal("permission not opened")
		}
		if err = conn.Cancel(timeout(t), acp.CancelNotification{SessionId: start.SessionId}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-cancelled:
		case <-time.After(5 * time.Second):
			t.Fatal("permission not cancelled")
		}
		select {
		case err = <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("prompt not cancelled")
		}
	})
}
func TestACPHostInputSteeringAndWithdraw(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		started, release := make(chan struct{}), make(chan struct{})
		p := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return api.Response{}, ctx.Err()
			}
			return api.Response{Content: api.Text("first"), Stop: "finished"}, nil
		}}, fake.Script{Require: "steering-value", Response: api.Response{Content: api.Text("steered"), Stop: "finished"}})
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
			_, err := conn.Prompt(timeout(t), acp.PromptRequest{SessionId: start.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("start")}})
			done <- err
		}()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("not started")
		}
		raw, err := conn.CallExtension(timeout(t), "_modular-agent/input", map[string]any{"sessionId": start.SessionId, "when": "after", "content": "withdraw-me"})
		if err != nil {
			t.Fatal(err)
		}
		receipt := api.Decode[struct {
			InputID string `json:"inputId"`
		}](raw)
		// The ACP withdraw extension now refers to proposals. The Harness
		// still hands back queued turn input to an authorized caller.
		withdrawn, err := a.Withdraw(timeout(t), string(start.SessionId), receipt.InputID)
		if err != nil || withdrawn.Content.Text() != "withdraw-me" {
			t.Fatal(withdrawn, err)
		}
		raw, err = conn.CallExtension(timeout(t), "_modular-agent/input", map[string]any{"sessionId": start.SessionId, "key": "steer", "when": "steer", "content": "steering-value", "actor": "forged-actor", "job": "forged-job", "copies": []string{"forged-copy"}, "calls": []api.Call{{ID: "forged-call", Name: "write", Input: api.JSON(map[string]string{"path": "forged.txt", "content": "no"})}}})
		if err != nil {
			t.Fatal(err)
		}
		close(release)
		select {
		case err = <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("steering stuck")
		}
		if !strings.Contains(c.text(), "steered") || len(p.Requests()) != 2 {
			t.Fatal(c.text(), p.Requests())
		}
		snap, _ := a.Snapshot(string(start.SessionId))
		if strings.Contains(string(api.JSON(snap)), "forged") {
			t.Fatal("wire caller forged trusted intake fields", snap)
		}
	})
}
func TestACPStdioMCPHelper(t *testing.T) {
	if os.Getenv("MODULAR_ACP_MCP_HELPER") != "1" {
		return
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "fact"}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: os.Getenv("MODULAR_ACP_FACT")}}}, nil, nil
	})
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func TestACPClientStdioServerSettings(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Content{call("fact", "mcp_stdio__fact", map[string]any{})}, Stop: "tools"}}, fake.Script{Require: "stdio-cobalt", Response: api.Response{Content: api.Text("verified stdio"), Stop: "finished"}})
		a := compose(t, root, p)
		c := &client{}
		conn, _ := connection(t, a, c)
		initClient(t, conn, false)
		spec := api.Decode[acp.McpServer](api.JSON(map[string]any{"name": "stdio", "command": os.Args[0], "args": []string{"-test.run=^TestACPStdioMCPHelper$"}, "env": []any{map[string]string{"name": "MODULAR_ACP_MCP_HELPER", "value": "1"}, map[string]string{"name": "MODULAR_ACP_FACT", "value": "stdio-cobalt"}}}))
		start, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{spec}})
		if err != nil {
			t.Fatal(err)
		}
		prompt(t, conn, start.SessionId, "fact", "")
		if !strings.Contains(c.text(), "verified stdio") {
			t.Fatal(c.text())
		}
	})
}
