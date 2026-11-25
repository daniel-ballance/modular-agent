package modular_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

var beacon = modular.Provider{
	ID: "beacon",
	Models: func() []modular.ModelInfo {
		return []modular.ModelInfo{{
			ModelRef:      modular.ModelRef{Provider: "beacon", ID: "demo"},
			ContextWindow: 4096, MaxOutput: 256, Input: []string{"text"},
		}}
	},
	Available: func() bool { return true },
	Supports:  modular.ProviderSupport{SafeToRepeat: true},
	Request: func(_ context.Context, _ modular.ModelRef, _ modular.ModelRequest, cx *modular.ProviderContext) (modular.AssistantMessage, error) {
		key, err := cx.Credential()
		if err != nil || key != "offline-key" {
			return modular.AssistantMessage{}, &modular.ModelError{
				Kind: modular.Credentials, Message: "Key unavailable or rejected",
			}
		}
		cx.Piece("text", "Beacon ")
		cx.Piece("text", "ready.")
		return modular.AssistantMessage{Content: modular.Text("Beacon ready."), Stop: "finished"}, nil
	},
}

func TestBeaconStreamsAndRecordsFailures(t *testing.T) {
	for _, key := range []string{"offline-key", "rejected"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv("BEACON_API_KEY", key)
			ctx := t.Context()
			agent := modulartest.Agent(t, modular.WithProvider(beacon), modular.WithModel("beacon/demo"))
			session, err := agent.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var pieces []string
			for event, err := range session.PromptStream(ctx, "Check the beacon.") {
				if err != nil {
					t.Fatal(err)
				}
				if text, ok := event.(modular.TextEvent); ok {
					pieces = append(pieces, text.Delta)
				}
			}
			turn, err := session.LastTurn(ctx)
			if err != nil || turn == nil {
				t.Fatalf("last turn: %+v, %v", turn, err)
			}
			if key == "offline-key" {
				if !slices.Equal(pieces, []string{"Beacon ", "ready."}) || turn.Text != "Beacon ready." {
					t.Fatalf("pieces %q, final text %q", pieces, turn.Text)
				}
				return
			}
			if len(pieces) != 0 || turn.Outcome == nil || turn.Outcome.Kind != "failed" {
				t.Fatalf("pieces %q, outcome %+v", pieces, turn.Outcome)
			}
			history, err := session.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.ContainsFunc(history, func(entry modular.HistoryEntry) bool {
				var message modular.AssistantMessage
				data, _ := json.Marshal(entry["message"])
				return entry["kind"] == "response" && json.Unmarshal(data, &message) == nil &&
					message.Stop == "failed" && message.Error != nil && message.Error.Kind == modular.Credentials
			}) {
				t.Fatal("no recorded credentials failure")
			}
		})
	}
}

// The test executable doubles as the plugin program.
func TestBeaconPluginProgram(t *testing.T) {
	if os.Getenv("BEACON_PLUGIN_TEST") != "1" {
		t.Skip("only run in the plugin child")
	}
	p := modulartest.ScriptedProvider([]modulartest.Reply{{Text: "Beacon ready."}})
	plugin := modular.Plugin{Name: "beacon-demo", Setup: func(r *modular.Registrar) error {
		return r.Provider(p)
	}}
	if err := modular.Serve(t.Context(), plugin); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestLoadServedBeaconProvider(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	ctx := t.Context()
	agent, err := modular.New(ctx,
		modular.WithProject(gitProject(t)),
		modular.WithProcessPlugin(modular.ProcessPlugin{
			Command: []string{exe, "-test.run=^TestBeaconPluginProgram$"},
			Env:     map[string]string{"BEACON_PLUGIN_TEST": "1"},
		}),
		modular.WithModel("scripted/script"))
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close(ctx)
	session, err := agent.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := session.Prompt(ctx, "Check the beacon.")
	if err != nil || turn.Text != "Beacon ready." {
		t.Fatalf("turn: %+v, %v", turn, err)
	}
}
