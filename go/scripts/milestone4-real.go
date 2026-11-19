// This explicit real-run driver is not an offline test. It never reads a key.
// Run: mise exec -- go run ./scripts/milestone4-real.go /absolute/path/to/bin/modular
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/acpinterface"
	"github.com/OWNER/modular-agent/go/anthropic"
	"github.com/OWNER/modular-agent/go/api"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
)

type client struct {
	mu          sync.Mutex
	trace       *os.File
	text        string
	permissions int
}

func (c *client) record(kind string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	fmt.Fprintln(c.trace, string(api.JSON(map[string]any{"kind": kind, "value": value})))
}
func (c *client) SessionUpdate(_ context.Context, p acp.SessionNotification) error {
	c.record("session/update", p)
	if p.Update.AgentMessageChunk != nil && p.Update.AgentMessageChunk.Content.Text != nil {
		c.mu.Lock()
		c.text += p.Update.AgentMessageChunk.Content.Text.Text
		c.mu.Unlock()
	}
	return nil
}
func (c *client) RequestPermission(_ context.Context, p acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	c.record("session/request_permission", p)
	option := "refuse"
	if p.ToolCall.Title != nil && strings.HasPrefix(*p.ToolCall.Title, "Allow read ") {
		option = "allow"
	}
	c.mu.Lock()
	c.permissions++
	c.mu.Unlock()
	return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{Outcome: "selected", OptionId: acp.PermissionOptionId(option)}}}, nil
}
func run() error {
	if len(os.Args) != 2 {
		return errors.New("usage: milestone4-real /absolute/path/to/bin/modular")
	}
	binary, err := filepath.Abs(os.Args[1])
	if err != nil {
		return err
	}
	evidence, err := os.MkdirTemp("", "modular-go-m4-real.")
	if err != nil {
		return err
	}
	fmt.Println("Evidence:", evidence)
	project := filepath.Join(evidence, "project")
	if err = os.Mkdir(project, 0700); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(project, "fact.txt"), []byte("marker=m4-saffron-91\ncount=13\n"), 0600); err != nil {
		return err
	}
	trace, err := os.OpenFile(filepath.Join(evidence, "acp.jsonl"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer trace.Close()
	c := &client{trace: trace}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	process, err := stdio.StartClient(ctx, c, stdio.Command{Executable: binary, Args: []string{"--mode", "acp", "--runtime", "durable", "--project", project, "--state", filepath.Join(evidence, "history"), "--settings", filepath.Join(evidence, "no-settings.json")}}, acp.ConnectionOptions{})
	if err != nil {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := process.Shutdown(ctx); e != nil {
			fmt.Fprintln(os.Stderr, "shutdown:", e)
		}
	}()
	conn := process.Connection
	initialized, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1})
	if err != nil {
		return err
	}
	c.record("initialize", initialized)
	if initialized.ProtocolVersion != 1 || !initialized.AgentCapabilities.LoadSession {
		return errors.New("ACP support not declared")
	}
	start, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
	if err != nil {
		return err
	}
	c.record("session/new", start)
	if len(start.ConfigOptions) < 2 || start.ConfigOptions[0].Select.CurrentValue != acp.SessionConfigValueId(anthropic.ModelID) {
		return errors.New("disallowed or missing model declaration")
	}
	configured, err := conn.SetSessionConfigOption(ctx, acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: start.SessionId, ConfigId: "approval", Value: "ask-always"}})
	if err != nil {
		return err
	}
	c.record("session/set_config_option", configured)
	prompt := acp.PromptRequest{SessionId: start.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("Use read on fact.txt, then reply in one short sentence giving its marker and twice its count. No delegation, bash, or other tools.")}, Meta: map[string]json.RawMessage{acpinterface.Namespace: api.JSON(map[string]string{"key": "m4-read"})}}
	outcome, err := conn.Prompt(ctx, prompt)
	if err != nil {
		return err
	}
	c.record("session/prompt", outcome)
	if outcome.StopReason != acp.StopReasonEndTurn {
		return errors.New("real turn did not complete")
	}
	c.mu.Lock()
	text, permissions := c.text, c.permissions
	c.mu.Unlock()
	if !strings.Contains(text, "m4-saffron-91") || !strings.Contains(text, "26") || permissions < 1 {
		return errors.New("real ACP answer or approval evidence missing")
	}
	duplicate, err := conn.Prompt(ctx, prompt)
	if err != nil {
		return err
	}
	c.record("session/prompt-duplicate", duplicate)
	list, err := conn.ListSessions(ctx, acp.ListSessionsRequest{})
	if err != nil {
		return err
	}
	c.record("session/list", list)
	raw, err := conn.CallExtension(ctx, "_modular/follow", map[string]any{"sessionId": start.SessionId})
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "history-view.json"), raw, 0600); err != nil {
		return err
	}
	var view struct{ Entries []api.Entry }
	if err = json.Unmarshal(raw, &view); err != nil {
		return err
	}
	models, turns, reads := 0, 0, 0
	for _, e := range view.Entries {
		switch e.Kind {
		case "model":
			models++
		case "turn.start":
			turns++
		case "tool.result":
			if api.Decode[api.ToolResult](e.Data).Status == "completed" {
				reads++
			}
		}
	}
	if turns != 1 || models != 2 || reads != 1 {
		return fmt.Errorf("unexpected work: turns=%d model responses=%d successful tools=%d", turns, models, reads)
	}
	if _, err = conn.CloseSession(ctx, acp.CloseSessionRequest{SessionId: start.SessionId}); err != nil {
		return err
	}
	summary := map[string]any{"time": time.Now().UTC(), "session": start.SessionId, "model": anthropic.ModelID, "answer": text, "permissions": permissions, "turns": turns, "model_responses": models, "successful_tools": reads, "duplicate_started_no_turn": true, "evidence": evidence}
	if err = os.WriteFile(filepath.Join(evidence, "summary.json"), api.JSON(summary), 0600); err != nil {
		return err
	}
	fmt.Println(string(api.JSON(summary)))
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
