package commands_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/commands"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/contextview"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/history"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"github.com/OWNER/modular-agent/go/local"
	"github.com/OWNER/modular-agent/go/modelselect"
	"github.com/OWNER/modular-agent/go/systemprompt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsPromptCommandsAndUnusedSession(t *testing.T) {
	runtimetest.Each(t, testSettingsPromptCommandsAndUnusedSession)
}
func testSettingsPromptCommandsAndUnusedSession(t *testing.T) {
	dir, project, global := t.TempDir(), t.TempDir(), filepath.Join(t.TempDir(), "global.json")
	if err := os.WriteFile(global, []byte("{\"model\":\"fake\",\"thinking\":\"low\",\"max_steps\":9}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(project, ".modular-agent"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".modular-agent", "settings.json"), []byte("{\"thinking\":\"high\",\"max_steps\":4}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "AGENTS.md"), []byte("Project rule: use teal."), 0600); err != nil {
		t.Fatal(err)
	}
	h := harness.New()
	defer h.Close()
	p := fake.New(fake.Script{Response: api.Response{Content: api.Text("teal"), Stop: "finished"}})
	for _, plugin := range []api.Plugin{history.Plugin(dir), configuration.Plugin(global, api.Settings{Model: "fake-alt", Thinking: "off", MaxSteps: 5, MaxOutput: 100}), p.Plugin(), modelselect.Plugin(), local.Plugin(), runtimetest.Plugin(t), contextview.Plugin(), systemprompt.Plugin(), commands.Plugin()} {
		if err := h.Load(plugin); err != nil {
			t.Fatal(err)
		}
	}
	a := h.API()
	id, err := a.New(context.Background(), project)
	if err != nil {
		t.Fatal(err)
	}
	snap, _ := a.Snapshot(id)
	if snap.Settings.Model != "fake" || snap.Settings.Thinking != "high" || snap.Settings.MaxSteps != 4 {
		t.Fatal(snap.Settings)
	}
	receipt, err := a.Submit(context.Background(), id, api.Input{Content: api.Text("/settings")})
	if err != nil || !strings.Contains(receipt.Command, "fake") {
		t.Fatal(receipt, err)
	}
	if len(p.Requests()) != 0 {
		t.Fatal("command invoked model")
	}
	if err = a.CloseSession(id); err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatal("unused session persisted", files)
	}
	id, err = a.New(context.Background(), project)
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"/model fake-alt", "/thinking off"} {
		if _, err = a.Submit(context.Background(), id, api.Input{Content: api.Text(command)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = a.Submit(context.Background(), id, api.Input{Content: api.Text("/unknown")}); err == nil {
		t.Fatal("unknown command went to model")
	}
	_, err = a.Submit(context.Background(), id, api.Input{Content: api.Text("What color?")})
	if err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(context.Background(), id)
	if err != nil || out.Status != "completed" {
		t.Fatal(out, err)
	}
	req := p.Requests()
	if len(req) != 1 || !strings.Contains(req[0].System, "Project rule: use teal.") || req[0].Thinking != "off" {
		t.Fatal(req)
	}
}
func TestKeyedInputRemainsTakenAfterNewHarness(t *testing.T) {
	runtimetest.Each(t, testKeyedInputRemainsTakenAfterNewHarness)
}
func testKeyedInputRemainsTakenAfterNewHarness(t *testing.T) {
	dir, project := t.TempDir(), t.TempDir()
	makeHarness := func(p *fake.Provider) *harness.Harness {
		h := harness.New()
		for _, plugin := range []api.Plugin{history.Plugin(dir), configuration.Plugin("", api.Settings{Model: "fake", Thinking: "off", MaxSteps: 3, MaxOutput: 100}), p.Plugin(), modelselect.Plugin(), runtimetest.Plugin(t), contextview.Plugin(), commands.Plugin()} {
			if err := h.Load(plugin); err != nil {
				t.Fatal(err)
			}
		}
		return h
	}
	h := makeHarness(fake.New(fake.Script{Response: api.Response{Content: api.Text("first answer"), Stop: "finished"}}))
	id, _ := h.API().New(context.Background(), project)
	first, err := h.API().Submit(context.Background(), id, api.Input{Key: "same-key", Content: api.Text("first")})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = h.API().Wait(context.Background(), id)
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	p := fake.New()
	h = makeHarness(p)
	defer h.Close()
	if err = h.API().Open(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	again, err := h.API().Submit(context.Background(), id, api.Input{Key: "same-key", Content: api.Text("retry")})
	if err != nil || !again.Duplicate || again.ID != first.ID || len(p.Requests()) != 0 {
		t.Fatal(again, err)
	}
}
