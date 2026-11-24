package modular_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestAGUIWaitingApprovalDeliveredOnReturn(t *testing.T) {
	var effects atomic.Int32
	bump := modular.NewTool("bump", "Bump.", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
		effects.Add(1)
		return "one", nil
	})
	a := modulartest.Agent(t, modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()), modular.WithLateAnswersStartTurns(true), modular.WithApproval(modular.All), modular.WithApprovalCoversNested(true), modular.WithMaxApprovalWaitMs(30000), modular.WithSettings(modular.Settings{"approvalWait": "untilDeadline"}), modular.WithTool(bump), modulartest.Script(`[{"toolCalls":[{"name":"bump","input":{}}]},{"text":"settled"}]`))
	actor := agActor(t)
	actor.Actor.ID = "user"
	url := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{actor}})
	id := agThread(t, url)
	origin := agPost(t, url+"/run", fmt.Sprintf(`{"threadId":%q,"runId":"initial","protocolVersion":"1.0","messages":[{"role":"user","id":"input","content":"Bump."}]}`, id), 200)
	if effects.Load() != 0 || !strings.Contains(origin, `"outcome":{"type":"success"}`) || strings.Contains(origin, "pendingToolCallIds") || strings.Contains(origin, "TOOL_CALL_START") {
		t.Fatalf("parked call appeared executable: %s", origin)
	}
	thread := url + "/threads/" + id
	res := agRequest(t, "GET", thread+"/presence", "", testAGToken, nil)
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("presence: %d", res.StatusCode)
	}
	snap := agReadBody(t, agRequest(t, "GET", thread, "", testAGToken, nil))
	var view struct {
		Declaration map[string]any
		Messages    []map[string]any
		Waiting     struct {
			Questions []struct {
				ID, ToolCallID, Message, ExpiresAt string
				Metadata                           map[string]any
			}
			ToolCalls []any
		}
	}
	if err := json.Unmarshal([]byte(snap), &view); err != nil || len(view.Waiting.Questions) != 1 || len(view.Waiting.ToolCalls) != 0 {
		t.Fatal(snap, err)
	}
	q := view.Waiting.Questions[0]
	if view.Declaration["approvalCoversNested"] != true || q.Metadata["modular-agent.coversNested"] != true || q.ToolCallID == "" || q.ExpiresAt == "" || !strings.Contains(q.Message, "bump {}") {
		t.Fatal(q)
	}
	body, _ := json.Marshal(map[string]any{"threadId": id, "runId": "approve", "protocolVersion": "1.0", "messages": view.Messages, "resume": []any{map[string]any{"interruptId": q.ID, "status": "resolved", "payload": map[string]bool{"allow": true}}}})
	result := agPost(t, url+"/run", string(body), 200)
	if effects.Load() != 1 || !strings.Contains(result, "settled") || !strings.Contains(result, `"outcome":{"type":"success"}`) {
		t.Fatal(result)
	}
}
