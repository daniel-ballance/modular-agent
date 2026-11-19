package main_test

import (
	"context"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/history"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
)

func TestExternalDurableCancelsCommandWithLongLocalHistory(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "modular")
	if b, err := exec.Command("go", "build", "-race", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatal(string(b), err)
	}
	project := filepath.Join(root, "project")
	if err := os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(root, "data")
	store, err := history.New(filepath.Join(data, "history"))
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.Acquire("long")
	if err != nil {
		t.Fatal(err)
	}
	// Keep the active branch short. Old responses still have to survive
	// appends and must not hold up dispatch or settlement on the new branch.
	snap := api.Session{Version: 1, ID: "long", Project: project}
	snap.Entries = append(snap.Entries, api.Entry{ID: "settings", Session: snap.ID, Kind: "setting", Data: api.JSON(api.Settings{Model: "conformance/echo", Approval: "off"})})
	parent := "settings"
	for i := 0; i < 300; i++ {
		id := fmt.Sprintf("response-%d", i)
		snap.Entries = append(snap.Entries, api.Entry{ID: id, Parent: parent, Session: snap.ID, Kind: "model", Content: api.Text(strings.Repeat("old response text. ", 100)), Data: api.JSON(api.Response{Stop: "finished"})})
		parent = id
	}
	snap.Entries = append(snap.Entries, api.Entry{ID: "move", Parent: parent, Session: snap.ID, Kind: "position", Data: api.JSON(api.PositionChange{To: new("settings")})})
	if err := lease.Save(snap); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	plugins := api.JSON([]any{map[string]any{"command": []string{binary, "--serve-plugin"}, "env": map[string]string{"MODULAR_AGENT_PLUGIN_PARTS": "durable-runtime"}}})
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	t.Setenv("MODULAR_AGENT_CONFORMANCE", "1")
	t.Setenv("MODULAR_AGENT_DATA_DIR", data)
	t.Setenv("MODULAR_AGENT_PLUGINS", string(plugins))
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	process, err := stdio.StartClient(ctx, &acpClient{}, stdio.Command{Executable: binary, Args: []string{"--mode", "acp", "--history-url", ""}, Dir: project, Stderr: os.Stderr}, acp.ConnectionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		stop, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := process.Shutdown(stop); err != nil {
			t.Error(err)
		}
	}()
	conn := process.Connection
	if _, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1}); err != nil {
		t.Fatal(err)
	}
	id := acp.SessionId(snap.ID)
	if _, err := conn.LoadSession(ctx, acp.LoadSessionRequest{SessionId: id, Cwd: project, McpServers: []acp.McpServer{}}); err != nil {
		t.Fatal(err)
	}
	type result struct {
		out acp.PromptResponse
		err error
	}
	settled := make(chan result, 1)
	go func() {
		out, err := conn.Prompt(ctx, acp.PromptRequest{SessionId: id, Prompt: []acp.ContentBlock{acp.TextBlock(`tool:bash {"command":"printf started > cancel-test; sleep 6; printf finished >> cancel-test"}`)}})
		settled <- result{out, err}
	}()
	marker := filepath.Join(project, "cancel-test")
	prompted := time.Now()
	for until := prompted.Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if b, err := os.ReadFile(marker); err == nil && string(b) == "started" {
			break
		} else if time.Now().After(until) {
			t.Fatalf("command did not start within five seconds: marker %q, read error %v", b, err)
		}
		select {
		case r := <-settled:
			t.Fatalf("prompt settled before command start: %+v, %v", r.out, r.err)
		default:
		}
	}
	started := time.Now()
	t.Logf("command started after %v", started.Sub(prompted))
	deadline, stop := context.WithDeadline(ctx, started.Add(5*time.Second))
	defer stop()
	if err := conn.Cancel(deadline, acp.CancelNotification{SessionId: id}); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-settled:
		if r.err != nil || r.out.StopReason != acp.StopReasonCancelled || time.Now().After(started.Add(5*time.Second)) {
			t.Fatalf("cancellation after %v: %+v, %v", time.Since(started), r.out, r.err)
		}
		t.Logf("cancelled prompt settled after %v", time.Since(started))
	case <-deadline.Done():
		t.Fatal("cancelled prompt did not settle within five seconds")
	}
	// The prompt reply alone does not prove that the command stopped.
	time.Sleep(time.Until(started.Add(6500 * time.Millisecond)))
	if b, err := os.ReadFile(marker); err != nil || string(b) != "started" {
		t.Fatalf("cancelled command was not stopped: marker %q, read error %v", b, err)
	}
}
