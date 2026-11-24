package modular_test

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestReceiptChecksWholeReleasedHandoff(t *testing.T) {
	var block atomic.Bool
	gate := modular.Plugin{Name: "group-policy", Setup: func(r *modular.Registrar) error {
		return r.OnOutput(func(_ context.Context, b modular.OutputBatch) (modular.OutputDecision, error) {
			for _, e := range b.Events {
				if block.Load() && e.Type == "reply" && bytes.Contains(e.Data, []byte(`"agui.release"`)) && bytes.Contains(e.Data, []byte(`"MESSAGES_SNAPSHOT"`)) {
					return modular.OutputDecision{Block: true}, nil
				}
			}
			return modular.OutputDecision{}, nil
		})
	}}
	a := modulartest.Agent(t, append(interfaceOptions(60000), modular.WithPlugin(gate), modular.WithDataDir(t.TempDir()), modular.WithDurability(modular.Kept))...)
	actor := agActor(t)
	actor.Actor.ID, actor.ClientID = "editor", "editor-primary"
	base := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{actor}})
	id := agThread(t, base)
	body := fmt.Sprintf(`{"threadId":%q,"runId":"first","protocolVersion":"1.0","messages":[{"id":"u","role":"user","content":"Pick."}],"tools":[{"name":"pick_color","description":"Pick a color.","parameters":{"type":"object"}}]}`, id)
	if run := agPost(t, base+"/run", body, 200); !strings.Contains(run, `"pendingToolCallIds"`) {
		t.Fatal("run did not hand off a call")
	}
	receipt := base + "/threads/" + id + "/run-receipt?runId=first"
	for _, tc := range []struct {
		block  bool
		status int
	}{{false, 200}, {true, 404}} {
		block.Store(tc.block)
		if r := agRequest(t, "GET", receipt, "", testAGToken, nil); r.StatusCode != tc.status {
			t.Fatalf("gate blocks complete release: %t, got HTTP %d, want %d", tc.block, r.StatusCode, tc.status)
		}
	}
}
