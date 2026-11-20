package main_test

import (
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
)

type acpClient struct {
	mu      sync.Mutex
	updates []acp.SessionNotification
}

func (c *acpClient) SessionUpdate(_ context.Context, p acp.SessionNotification) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.updates = append(c.updates, p)
	return nil
}
func (c *acpClient) RequestPermission(context.Context, acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{Outcome: "selected", OptionId: "allow"}}}, nil
}
func TestExecutableACPClientLibraryAndReopen(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		bin := filepath.Join(root, "modular")
		cmd := exec.Command("go", "build", "-o", bin, ".")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatal(string(b), err)
		}
		project := filepath.Join(root, "project")
		if err := os.Mkdir(project, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(project, "fact.txt"), []byte("cobalt-73"), 0600); err != nil {
			t.Fatal(err)
		}
		scripts := [][]fake.Script{
			{{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "read", Name: "read", Input: api.JSON(map[string]string{"path": "fact.txt"})}}}, Stop: "tools"}}, {Require: "cobalt-73", Response: api.Response{Content: api.Text("Read cobalt-73 over ACP."), Stop: "finished"}}},
			{{Require: "Read cobalt-73 over ACP.", Response: api.Response{Content: api.Text("Remembered cobalt-73."), Stop: "finished"}}},
		}
		id := acp.SessionId("")
		for index, script := range scripts {
			path := filepath.Join(root, "script.json")
			if err := os.WriteFile(path, api.JSON(script), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			c := &acpClient{}
			process, err := stdio.StartClient(ctx, c, stdio.Command{Executable: bin, Args: []string{"--runtime", runtimetest.Plugin(t).Name, "--project", project, "--state", filepath.Join(root, "history"), "--settings", filepath.Join(root, "absent.json"), "--script", path, "--mode", "acp"}}, acp.ConnectionOptions{})
			if err != nil {
				t.Fatal(err)
			}
			shutdown := func() {
				stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := process.Shutdown(stop); err != nil {
					t.Error(err)
				}
			}
			t.Cleanup(shutdown)
			conn := process.Connection
			initialized, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1})
			if err != nil || !initialized.AgentCapabilities.LoadSession {
				t.Fatal(initialized, err)
			}
			if index == 0 {
				created, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
				if err != nil {
					t.Fatal(err)
				}
				id = created.SessionId
				_, err = conn.SetSessionConfigOption(ctx, acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: id, ConfigId: "approval", Value: "all"}})
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err = conn.LoadSession(ctx, acp.LoadSessionRequest{SessionId: id, Cwd: project, McpServers: []acp.McpServer{}}); err != nil {
					t.Fatal(err)
				}
			}
			out, err := conn.Prompt(ctx, acp.PromptRequest{SessionId: id, Prompt: []acp.ContentBlock{acp.TextBlock("read or remember fact.txt")}, Meta: map[string]json.RawMessage{acpinterface.Namespace: api.JSON(map[string]string{"key": "input-" + string(rune('0'+index))})}})
			if err != nil || out.StopReason != acp.StopReasonEndTurn {
				t.Fatal(out, err)
			}
			c.mu.Lock()
			text := string(api.JSON(c.updates))
			c.mu.Unlock()
			if !strings.Contains(text, "cobalt-73") {
				t.Fatal("no ACP output", text)
			}
			if index == 0 && !strings.Contains(text, "tool_call_update") {
				t.Fatal("tool calls not shown", text)
			}
			shutdown()
		}
	})
}
