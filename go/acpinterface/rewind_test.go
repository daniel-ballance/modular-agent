package acpinterface_test

import (
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"testing"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestACPMoveWithRewindRestoresTheEarliestPoint(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		project, state := t.TempDir(), t.TempDir()
		h, err := vanilla.New(vanilla.Options{Project: project, History: state, Provider: conformancemodel.Plugin(), Model: conformancemodel.ID, Runtime: runtimetest.Plugin(t)})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a := h.API()
		conn, close := connection(t, a, &client{})
		defer close()
		init := initClient(t, conn, false)
		var meta struct{ Declaration struct{ Rewinding bool } }
		if err = json.Unmarshal(init.Meta[acpinterface.Namespace], &meta); err != nil || !meta.Declaration.Rewinding {
			t.Fatalf("local rewind not declared: %+v, %v", meta, err)
		}
		s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		prompt(t, conn, s.SessionId, `tool:write {"path":"tracked","content":"one"}`, "")
		before, _ := a.Snapshot(string(s.SessionId))
		prompt(t, conn, s.SessionId, `tool:write {"path":"tracked","content":"two"}`, "")
		prompt(t, conn, s.SessionId, `tool:write {"path":"new","content":"three"}`, "")
		file := filepath.Join(project, "tracked")
		if data, err := os.ReadFile(file); err != nil || string(data) != "two" {
			t.Fatalf("tool did not change file: %q %v", data, err)
		}
		raw, err := conn.CallExtension(timeout(t), "_modular-agent/history", map[string]any{"sessionId": s.SessionId, "after": before.Position})
		var history struct {
			Entries []struct {
				Kind string
				Data struct{ Point string }
			}
		}
		if err != nil || json.Unmarshal(raw, &history) != nil {
			t.Fatalf("history: %s %v", raw, err)
		}
		starts := 0
		for _, e := range history.Entries {
			if e.Kind == "turnStart" && e.Data.Point != "" {
				starts++
			}
		}
		if starts != 2 {
			t.Fatalf("expected portable points on both turn starts: %s", raw)
		}
		if _, err = conn.CallExtension(timeout(t), "_modular-agent/move", map[string]any{"sessionId": s.SessionId, "entryId": before.Position, "rewind": true}); err != nil {
			t.Fatal(err)
		}
		after, _ := a.Snapshot(string(s.SessionId))
		if data, err := os.ReadFile(file); err != nil || string(data) != "one" || after.Position != before.Position {
			t.Fatalf("rewound files or position: %q %v, got %s want %s", data, err, after.Position, before.Position)
		}
		if _, err := os.Stat(filepath.Join(project, "new")); !os.IsNotExist(err) {
			t.Fatalf("later file was not removed: %v", err)
		}
		// A divergent target is refused.
		abandoned := after.Entries[len(after.Entries)-2].ID
		_, err = conn.CallExtension(timeout(t), "_modular-agent/move", map[string]any{"sessionId": s.SessionId, "entryId": abandoned, "rewind": true})
		if rpc, ok := err.(*acp.RequestError); !ok || rpc.Code != -32602 {
			t.Fatalf("rewind onto abandoned branch: %T %v", err, err)
		}
		if out := prompt(t, conn, s.SessionId, "after rewind", ""); out.StopReason != acp.StopReasonEndTurn {
			t.Fatal(out)
		}
	})
}

type outsideTool struct{ effects *int }

func (t outsideTool) Tools(api.Session) []api.Tool {
	return []api.Tool{{Name: "outside", External: true, Callers: []string{"ui"}, Input: api.JSON(map[string]string{"type": "object"})}}
}
func (t outsideTool) Run(_ context.Context, _ api.Session, call api.Call, _ func(string)) api.ToolResult {
	(*t.effects)++
	return api.ToolResult{Call: call.ID, Status: "completed", Content: api.Text("one outside effect")}
}

func TestRewindReportsOutsideCallWithoutUndoingIt(t *testing.T) {
	project := t.TempDir()
	h, err := vanilla.New(vanilla.Options{Project: project, History: t.TempDir(), Model: conformancemodel.ID, Provider: conformancemodel.Plugin()})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	effects := 0
	if err = h.Load(api.Plugin{Name: "outside", Setup: func(a api.API) error { return a.Provide("tools.outside", outsideTool{&effects}) }}); err != nil {
		t.Fatal(err)
	}
	a := h.API()
	conn, _ := connection(t, a, &client{})
	initClient(t, conn, false)
	s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project})
	if err != nil {
		t.Fatal(err)
	}
	runtimetest.Publish(t, a, string(s.SessionId))
	mark, err := a.Record(timeout(t), string(s.SessionId), api.Entry{Kind: "test.mark"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := a.CallTool(timeout(t), string(s.SessionId), api.Call{Name: "outside", Input: api.JSON(map[string]any{})})
	if err != nil || result.Status != "completed" {
		t.Fatal(result, err)
	}
	raw, err := conn.CallExtension(timeout(t), "_modular-agent/move", map[string]any{"sessionId": s.SessionId, "entryId": mark.ID, "rewind": true})
	report := api.Decode[struct{ OutOfReach []string }](raw).OutOfReach
	if err != nil || len(report) != 1 || report[0] != result.Call || effects != 1 {
		t.Fatal(string(raw), err, effects)
	}
}

func TestOutsideTurnToolPointAndRewindRefusals(t *testing.T) {
	project := t.TempDir()
	h, err := vanilla.New(vanilla.Options{Project: project, History: t.TempDir(), Provider: conformancemodel.Plugin(), Model: conformancemodel.ID})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	a, ctx := h.API(), timeout(t)
	id, err := a.New(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	runtimetest.Publish(t, a, id)
	mark, err := a.Record(ctx, id, api.Entry{Kind: "test.mark"})
	if err != nil {
		t.Fatal(err)
	}
	call := func() {
		t.Helper()
		result, err := a.CallTool(ctx, id, api.Call{Name: "write", Input: api.JSON(map[string]string{"path": "changed", "content": "from UI"})})
		if err != nil || result.Status != "completed" {
			t.Fatal(result, err)
		}
	}
	call()
	snap, _ := a.Snapshot(id)
	started := ""
	for _, e := range snap.Branch() {
		if e.Kind == "tool.started" && e.Turn == "" {
			started = e.Point
		}
	}
	if started == "" {
		t.Fatal("no outside-turn tool point")
	}
	if err = a.Move(ctx, id, mark.ID, true); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(project, "changed")
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("UI write still present: %v", err)
	}
	call()
	// A finished job still represents work outside the working environment.
	job, err := a.Record(ctx, id, api.Entry{Kind: "job.end", Job: "settled"})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Move(ctx, id, mark.ID, true); err == nil {
		t.Fatal("rewind crossed a job")
	}
	snap, _ = a.Snapshot(id)
	if data, err := os.ReadFile(file); err != nil || string(data) != "from UI" || snap.Position != job.ID {
		t.Fatalf("refusal changed files or position: %q, %v, %s", data, err, snap.Position)
	}
	if err = a.Move(ctx, id, mark.ID, false); err != nil {
		t.Fatalf("plain move: %v", err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("plain move touched files: %v", err)
	}
}
