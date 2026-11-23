package modular_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

// Unlike the kit's in-turn choice, this question outlasts the originating turn.
// With no presence stream, the two committed waits must be delivered together.
func TestAGUIEndedMixedWait(t *testing.T) {
	const script = `[{"toolCalls":[{"name":"pick_color","input":{"palette":"warm"}},{"name":"caption","input":{}}]},{"text":"Mixed waits settled."}]`
	caption := modular.NewTool("caption", "Ask for a caption.", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		ans, err := tc.Ask(ctx, modular.Question{Kind: "text", Question: "Caption?"}, modular.AskOptions{Wait: time.Millisecond, Then: "leaveOpen"})
		return ans.Value, err
	})
	a := modulartest.Agent(t, modulartest.Script(script), modular.WithLateAnswersStartTurns(true), modular.WithTool(caption), modular.WithInterfaceTools(modular.InterfaceToolSource{SourceID: "palette", ActorID: "user", RouteID: "browser", ResultTimeoutMS: 60000, Tools: []modular.ToolDefinition{{Name: "pick_color", Description: "Pick.", Parameters: json.RawMessage(`{"type":"object"}`), Callers: []string{"model"}}}}))
	actor := agActor(t)
	actor.Actor.ID = "user"
	url := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{actor}})
	id := agThread(t, url)
	stream := agPost(t, url+"/run", fmt.Sprintf(`{"threadId":%q,"runId":"initial","protocolVersion":"1.0","messages":[{"role":"user","id":"input","content":"Pick and caption."}],"tools":[{"name":"pick_color","description":"Pick.","parameters":{"type":"object"}}]}`, id), 200)
	var call, question string
	var messages []map[string]any
	for _, line := range strings.Split(stream, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		var ev struct {
			Type, ToolCallID string
			Messages         []map[string]any
			Outcome          struct {
				Type       string
				Interrupts []struct{ ID string }
			}
		}
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			t.Fatal(err)
		}
		switch ev.Type {
		case "TOOL_CALL_END":
			call = ev.ToolCallID
		case "MESSAGES_SNAPSHOT":
			messages = ev.Messages
		case "RUN_FINISHED":
			if ev.Outcome.Type == "interrupt" && len(ev.Outcome.Interrupts) == 1 {
				question = ev.Outcome.Interrupts[0].ID
			}
		}
	}
	if call == "" || question == "" {
		t.Fatalf("missing terminal mixed wait: call=%q question=%q", call, question)
	}
	messages = append(messages, map[string]any{"role": "tool", "id": "provisional", "toolCallId": call, "content": "amber"})
	body, _ := json.Marshal(map[string]any{"threadId": id, "runId": "complete", "protocolVersion": "1.0", "messages": messages, "resume": []any{map[string]any{"interruptId": question, "status": "resolved", "payload": "Sunset"}}})
	next := agPost(t, url+"/run", string(body), 200)
	if !strings.Contains(next, "Mixed waits settled.") || !strings.Contains(next, `"outcome":{"type":"success"}`) {
		t.Fatalf("expected result-only continuation: %s", next)
	}
}
