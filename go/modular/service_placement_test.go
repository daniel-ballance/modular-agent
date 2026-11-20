package modular_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestServicePlacementSettlesDisconnectedCall(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("test-2d99e29c207ca2ce8fe29b96d3d6b4a8"), 0600); err != nil {
		t.Fatal(err)
	}
	started, stopped := make(chan struct{}), make(chan struct{})
	plugin := modular.Plugin{Name: "disconnect-test", Setup: func(r *modular.Registrar) error {
		return r.Tool(modular.NewTool("hold", "Wait for connection loss.", func(ctx context.Context, _ struct{}, _ *modular.ToolContext) (string, error) {
			close(started)
			<-ctx.Done()
			close(stopped)
			return "", ctx.Err()
		}))
	}}
	svc, err := modular.ServeService(ctx, plugin, modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: token})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	spec := modular.ServicePlugin{URL: svc.URL, TokenFile: token}
	b, err := json.Marshal([]map[string]string{{"url": spec.URL, "tokenFile": token}})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODULAR_AGENT_PLUGINS", string(b))
	a := modulartest.Agent(t, modular.WithPluginHost(true), modulartest.Script(`[{"toolCalls":[{"name":"hold","input":{}}]},{"text":"Done."}]`))
	session, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan modular.PromptResult, 1)
	go func() { result, _ := session.Prompt(ctx, "Start work."); done <- result }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("call not dispatched")
	}
	if err := svc.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	default:
		t.Fatal("service closed before plugin work stopped")
	}
	select {
	case turn := <-done:
		if results := turn.ToolResults(); len(results) != 1 || results[0].Status != modular.OutcomeUnknown {
			t.Fatalf("settlement = %+v", results)
		}
	case <-ctx.Done():
		t.Fatal("call did not settle")
	}
	_, err = modular.New(ctx, modular.WithServicePlugin(spec))
	requireCode(t, err, modular.InvalidComposition)
}
