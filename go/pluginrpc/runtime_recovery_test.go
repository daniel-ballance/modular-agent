package pluginrpc

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"testing"
)

type checkpointPorts struct {
	api.TurnPorts
	session api.Session
	gates   int
}

func (p *checkpointPorts) Record(_ context.Context, e api.Entry) (api.Entry, error) {
	e.ID, e.Parent, e.Turn = api.ID(), p.session.Position, "turn"
	p.session.Entries = append(p.session.Entries, e)
	p.session.Position = e.ID
	return e, nil
}

func (p *checkpointPorts) Hook(_ context.Context, hook string, value any) (any, error) {
	switch hook {
	case "runtime.step.after":
		p.gates++
	case "runtime.tool.after":
		checked := value.(api.AfterTool)
		checked.Result.Content = api.Text("checked by host")
		return checked, nil
	}
	return value, nil
}

func (p *checkpointPorts) Emit(context.Context, api.Event) {}

func TestRecoverySettlesBeforeHandoffAndReplaysGate(t *testing.T) {
	ctx := context.Background()
	ports := &checkpointPorts{}
	add := func(e api.Entry) api.Entry {
		saved, _ := ports.Record(ctx, e)
		return saved
	}
	offered := []string{"unsafe"}
	add(api.Entry{Kind: "model.request", Step: "s", OfferedTools: &offered})
	c := api.Call{ID: "c", Name: "unsafe", Input: api.JSON(object{}), Origin: "model", Actor: "actor", Step: "s"}
	response := responseDraft("s", responseOut(api.Response{Stop: "tools", Content: api.Content{{Type: "tool_call", Call: &c}}}))
	response.ID = ""
	add(response)
	add(api.Entry{Kind: "tool.started", Call: c.ID, Step: c.Step, Data: api.JSON(c)})
	turn := api.Turn{ID: "turn", Session: "session", Actor: "actor", IO: ports, Access: &runtimeClient{}, Tools: []api.Tool{{Name: "unsafe"}}}
	w := newRuntimeWork(turn)
	i, err := w.restoreInterrupted(ctx, ports.session, true)
	if err != nil || len(objects(i["calls"])) != 0 || w.results[c.ID].Status != "unknown" {
		t.Fatal(i, w.results, err)
	}
	s := asObject(i["lastStep"])
	if _, ok := s["decision"]; ok || str(s, "stepId") != "s" {
		t.Fatal(s)
	}
	if _, err := resumeStep(ports.session, "turn", object{}); Code(err) != "invalid_request" {
		t.Fatal("omitted answered step was accepted", err)
	}
	for range 2 {
		_, err := w.hook(ctx, "step.after", object{"stepId": "s", "response": w.active.answer})
		if err != nil {
			t.Fatal(err)
		}
	}
	if ports.gates != 1 {
		t.Fatalf("gate called %d times", ports.gates)
	}
	w = newRuntimeWork(turn)
	i, err = w.restoreInterrupted(ctx, ports.session, true)
	last := asObject(i["lastStep"])
	decision, committed := last["decision"]
	if err != nil || !committed || decision != nil {
		t.Fatal(i, err)
	}
	step, err := resumeStep(ports.session, "turn", i)
	if err != nil || !step.Committed {
		t.Fatal(step, err)
	}
	last["decision"] = object{"refuse": "different decision"}
	i["lastStep"] = last
	if _, err := resumeStep(ports.session, "turn", i); Code(err) != "invalid_request" {
		t.Fatal("different decision was accepted", err)
	}
	end := len(ports.session.Entries) - 1
	if ports.session.Entries[end].Kind != portable.StepAfterKind {
		t.Fatal("missing decision")
	}
	ports.session.Entries[end] = ports.session.Entries[end].Redacted()
	if _, err := newRuntimeWork(turn).restoreInterrupted(ctx, ports.session, true); err == nil {
		t.Fatal("erased decision was treated as due")
	}
}

func TestToolRefusalReturnsTheCommittedResult(t *testing.T) {
	ports := &checkpointPorts{}
	w := newRuntimeWork(api.Turn{ID: "turn", IO: ports})
	c := api.Call{ID: "c", Name: "unoffered", Input: api.JSON(object{})}
	w.calls[c.ID], w.committed[c.ID] = c, true
	value, err := w.beforeTool(context.Background(), object{"call": callOut(c)})
	if err != nil {
		t.Fatal(err)
	}
	r := resultIn(asObject(asObject(value)["result"]))
	if r.Call != c.ID || r.Status != "refused" || r.Content.Text() != "checked by host" || len(ports.session.Entries) != 1 || !sameJSON(resultOut(w.results[c.ID]), asObject(value)["result"]) {
		t.Fatal(value, ports.session.Entries)
	}
}
