package acpinterface_test

import (
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestACPLoadRecoversForeignInterruptedTurn(t *testing.T) {
	for _, tc := range []struct {
		name, fixture, wantStatus string
		starts                    int
	}{
		{"unsafe bash", "foreign-interrupted-turn.json", "outcomeUnknown", 1},
		{"repeatable read with revoked tools", "foreign-revoked-tools.json", "outcomeUnknown", 1},
		{"unstarted read with revoked tools", "foreign-revoked-tools.json", "refused", 0},
	} {
		t.Run(tc.name, func(t *testing.T) { checkForeignTurn(t, tc.fixture, tc.wantStatus, tc.starts) })
	}
}

func checkForeignTurn(t *testing.T, fixture, wantStatus string, wantStarts int) {
	t.Helper()
	const id = "foreign-crash"
	const path = "/v1/sessions/" + id
	root := t.TempDir()
	raw, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatal(err)
	}
	if wantStarts == 0 {
		// Keep the revocation, but omit the previously started call. The
		// revocation then attaches directly to the model response.
		entries = append(entries[:len(entries)-2], json.RawMessage(`{"id":"revoke","parentId":"reply","sessionId":"foreign-crash","kind":"actorJoined","time":1007,"writer":"peer","modelVisible":false,"data":{"actor":{"id":"user","kind":"host","rights":["watch","input","vendor.future"]}}}`))
	}
	service, err := historyhttp.New(t.TempDir(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { service.Close() })
	server := httptest.NewServer(service.Handler("test-token"))
	t.Cleanup(server.Close)
	wire := servicehttp.NewClient(server.URL, "test-token")
	ctx := timeout(t)
	call := func(method, path string, input, output any) {
		t.Helper()
		if err := wire.CallMethod(ctx, method, path, "", input, output); err != nil {
			t.Fatal(method, path, err)
		}
	}
	// Seed the service with shared entries, without this build's history writer.
	var out any
	call("PUT", path, map[string]any{"project": root, "created": 1000}, &out)
	var lease struct{ Lease string }
	call("POST", path+"/lease", map[string]string{"owner": "peer"}, &lease)
	call("POST", path+"/entries", map[string]any{"entries": entries, "lease": lease.Lease}, &out)
	call("DELETE", path+"/lease/"+lease.Lease, nil, &out)

	h, err := vanilla.New(vanilla.Options{Project: root, History: t.TempDir(), Store: historyhttp.Plugin(wire), Provider: conformancemodel.Plugin(), Model: conformancemodel.ID, Runtime: durable.Plugin()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	conn, _ := connection(t, h.API(), &client{})
	initClient(t, conn, false)
	if _, err := conn.LoadSession(ctx, acp.LoadSessionRequest{SessionId: id, Cwd: root}); err != nil {
		t.Fatal(err)
	}
	if outcome, err := h.API().Wait(ctx, id); err != nil || outcome.Status != "completed" {
		t.Fatalf("turn did not complete: %+v, %v", outcome, err)
	}

	snap, err := h.API().Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(snap.Actors[snap.Actor].Rights, "vendor.future") {
		t.Error("unknown right was not preserved")
	}
	if h.API().Authorize(id, snap.Actor, "vendor.future") {
		t.Error("unknown right granted authority")
	}

	view, err := conn.CallExtension(ctx, "_modular-agent/history", map[string]any{"sessionId": id})
	if err != nil {
		t.Fatal(err)
	}
	type history struct {
		Entries []struct {
			Kind, TurnID, ToolCallID string
			Data                     json.RawMessage
		}
	}
	var shared, displayed history
	call("GET", path, nil, &shared)
	starts := 0
	for _, e := range shared.Entries {
		if e.Kind == "toolStarted" && e.ToolCallID == "call" {
			starts++
		}
	}
	if err := json.Unmarshal(view, &displayed); err != nil {
		t.Fatal(err)
	}
	results, ends := 0, 0
	for _, e := range displayed.Entries {
		switch {
		case e.Kind == "toolResult" && e.ToolCallID == "call":
			results++
			var data struct{ Status string }
			if err := json.Unmarshal(e.Data, &data); err != nil || e.TurnID != "interrupted" || data.Status != wantStatus {
				t.Errorf("wrong result for interrupted call: %+v, %s (%v)", e, e.Data, err)
			}
		case e.Kind == "turnEnd":
			ends++
			var data struct{ Outcome struct{ Kind string } }
			if err := json.Unmarshal(e.Data, &data); err != nil || e.TurnID != "interrupted" || data.Outcome.Kind != "completed" {
				t.Errorf("wrong turn end: %+v, %s (%v)", e, e.Data, err)
			}
		}
	}
	if starts != wantStarts || results != 1 || ends != 1 {
		t.Errorf("expected %d starts, one result and one turn end, got %d, %d, %d", wantStarts, starts, results, ends)
	}
	if _, err := os.Stat(filepath.Join(root, "crash.txt")); !os.IsNotExist(err) {
		t.Errorf("interrupted command must not run again, stat error: %v", err)
	}
}
