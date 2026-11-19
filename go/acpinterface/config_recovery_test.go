package acpinterface_test

import (
	"context"
	"modular/api"
	"modular/fake"
	"modular/internal/runtimetest"
	"modular/vanilla"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestACPModelChangesDuringGenerationApplyNextTurn(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		started, release := make(chan struct{}), make(chan struct{})
		p := fake.New(fake.Script{Run: func(ctx context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return api.Response{}, ctx.Err()
			}
			return api.Response{Content: api.Text("old selection"), Stop: "finished"}, nil
		}}, fake.Script{Response: api.Response{Content: api.Text("new selection"), Stop: "finished"}})
		a := compose(t, root, p)
		selections := make(chan string, 4)
		if err := a.Handle("runtime.step.before", "", func(_ context.Context, v any) (api.Decision, error) {
			sc := v.(api.StepContext)
			selections <- sc.Turn.Access.Model().ID + ":" + sc.Request.Thinking
			return api.Decision{}, nil
		}); err != nil {
			t.Fatal(err)
		}
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
			t.Fatal("not generating")
		}
		for _, setting := range []struct{ id, value string }{{"model", "fake/fake-alt"}, {"thinking", "high"}} {
			_, err = conn.SetSessionConfigOption(timeout(t), acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: start.SessionId, ConfigId: acp.SessionConfigId(setting.id), Value: acp.SessionConfigValueId(setting.value)}})
			if err != nil {
				t.Fatal(err)
			}
		}
		close(release)
		if err = <-done; err != nil {
			t.Fatal(err)
		}
		prompt(t, conn, start.SessionId, "next", "")
		if first, second := <-selections, <-selections; first != "fake:off" || second != "fake-alt:high" {
			t.Fatal(first, second)
		}
	})
}
func TestRecoveryKeepsRecordedModelAfterNextTurnConfiguration(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root, state := t.TempDir(), t.TempDir()
		started := make(chan struct{})
		p := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			close(started)
			<-ctx.Done()
			return api.Response{}, ctx.Err()
		}})
		options := vanilla.Options{Project: root, History: state, Provider: p.Plugin(), Model: "fake", Runtime: runtimetest.Plugin(t)}
		h, err := vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		a := h.API()
		id, err := a.New(timeout(t), root)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = a.Submit(timeout(t), id, api.Input{Content: api.Text("first")}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("not generating")
		}
		snap, _ := a.Snapshot(id)
		snap.Settings.Model = "fake-alt"
		snap.Settings.Thinking = "high"
		if err = a.SetSettings(timeout(t), id, snap.Settings); err != nil {
			t.Fatal(err)
		}
		if err = h.Close(); err != nil {
			t.Fatal(err)
		}
		scripts := []fake.Script{}
		if runtimetest.Plugin(t).Name == "durable" {
			scripts = append(scripts, fake.Script{Response: api.Response{Content: api.Text("resumed"), Stop: "finished"}})
		}
		scripts = append(scripts, fake.Script{Response: api.Response{Content: api.Text("next"), Stop: "finished"}})
		options.Provider = fake.New(scripts...).Plugin()
		h, err = vanilla.New(options)
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a = h.API()
		selections := make(chan string, 4)
		a.Handle("runtime.step.before", "", func(_ context.Context, v any) (api.Decision, error) {
			sc := v.(api.StepContext)
			selections <- sc.Turn.Access.Model().ID + ":" + sc.Request.Thinking
			return api.Decision{}, nil
		})
		if err = a.Open(timeout(t), id); err != nil {
			t.Fatal(err)
		}
		if _, err = a.Wait(timeout(t), id); err != nil {
			t.Fatal(err)
		}
		if runtimetest.Plugin(t).Name == "durable" {
			if got := <-selections; got != "fake:off" {
				t.Fatal("recovery used next turn's selection", got)
			}
		}
		a.Submit(timeout(t), id, api.Input{Content: api.Text("next")})
		if _, err = a.Wait(timeout(t), id); err != nil {
			t.Fatal(err)
		}
		if got := <-selections; got != "fake-alt:high" {
			t.Fatal("new selection lost", got)
		}
	})
}
