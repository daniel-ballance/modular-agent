package modular_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type agApprovalInterrupt struct {
	ID, Reason, ToolCallID, Message, ExpiresAt string
	Metadata                                   map[string]any
}

func checkApprovalCall(t *testing.T, metadata map[string]any, name string, input map[string]any) {
	t.Helper()
	want := map[string]any{"name": name, "input": input}
	if got := metadata["modular-agent.approvalCall"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("approvalCall = %#v; want %#v", got, want)
	}
}

type agApprovalOutcome struct {
	Type       string
	Interrupts []agApprovalInterrupt
}

// Keep the same presence stream open for the run and the snapshot.
func agApprovalViews(t *testing.T, opts ...modular.Option) (agApprovalOutcome, []agApprovalInterrupt) {
	t.Helper()
	tool := modular.NewTool("codemode", "Run a script.", func(context.Context, struct {
		Code string `json:"code"`
	}, *modular.ToolContext) (string, error) {
		t.Error("call started without an allow")
		return "", nil
	})
	a := modulartest.Agent(t, append(opts, modular.WithApproval(modular.All), modular.WithTool(tool), modulartest.Script(`[{"toolCalls":[{"name":"codemode","input":{"code":"model draft"}}]},{"text":"done"}]`))...)
	url := agURL(t, a, modular.ServeAGUIOptions{})
	id := agThread(t, url)
	thread := url + "/threads/" + id
	presence := agRequest(t, "GET", thread+"/presence", "", testAGToken, nil)
	defer presence.Body.Close()
	if presence.StatusCode != 200 {
		t.Fatalf("presence: HTTP %d", presence.StatusCode)
	}
	stream := agPost(t, url+"/run", fmt.Sprintf(`{"threadId":%q,"runId":"ask","protocolVersion":"1.0","messages":[{"role":"user","id":"input","content":"Run a script."}]}`, id), 200)
	var outcome agApprovalOutcome
	for line := range strings.SplitSeq(stream, "\n") {
		if data, ok := strings.CutPrefix(line, "data: "); ok {
			var e struct {
				Type    string
				Outcome agApprovalOutcome
			}
			if err := json.Unmarshal([]byte(data), &e); err != nil {
				t.Fatal(err)
			}
			if e.Type == "RUN_FINISHED" {
				outcome = e.Outcome
			}
		}
	}
	var snapshot struct {
		Waiting struct{ Questions []agApprovalInterrupt }
	}
	res := agRequest(t, "GET", thread, "", testAGToken, nil)
	if err := json.NewDecoder(res.Body).Decode(&snapshot); err != nil || res.StatusCode != 200 {
		t.Fatalf("snapshot: HTTP %d (%v)", res.StatusCode, err)
	}
	return outcome, snapshot.Waiting.Questions
}

func TestAGUILiveApprovalCallUsesRewrittenInput(t *testing.T) {
	const input = `{"code":"a = tools.read('a')\nprint(a)"}`
	rewrite := modular.Plugin{Name: "rewrite", Setup: func(r *modular.Registrar) error {
		return r.OnToolBefore(func(context.Context, modular.ToolBefore) (modular.Gate, error) {
			return modular.Gate{Input: json.RawMessage(input)}, nil
		})
	}}
	for _, cover := range []bool{false, true} {
		t.Run(fmt.Sprintf("coversNested=%t", cover), func(t *testing.T) {
			run, snapshot := agApprovalViews(t, modular.WithApprovalCoversNested(cover), modular.WithPlugin(rewrite))
			if run.Type != "interrupt" || len(run.Interrupts) != 1 || len(snapshot) != 1 || run.Interrupts[0].ID != snapshot[0].ID {
				t.Fatalf("expected the same approval in the run and snapshot: run %+v, snapshot %+v", run, snapshot)
			}
			for _, q := range []agApprovalInterrupt{run.Interrupts[0], snapshot[0]} {
				checkApprovalCall(t, q.Metadata, "codemode", map[string]any{"code": "a = tools.read('a')\nprint(a)"})
				if q.Reason != "approval" || !strings.Contains(q.Message, "codemode "+input) || strings.Contains(q.Message, "model draft") {
					t.Fatalf("wrong approval prompt: %q", q.Message)
				}
				if got, ok := q.Metadata["modular-agent.coversNested"]; ok != cover || ok && got != true {
					t.Fatalf("coversNested = %v (present %t), want coverage %t", got, ok, cover)
				}
			}
		})
	}
}
