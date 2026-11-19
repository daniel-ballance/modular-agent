package acpinterface_test

import (
	"encoding/json"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/conformancemodel"
	"github.com/OWNER/modular-agent/go/durable"
	"github.com/OWNER/modular-agent/go/historyhttp"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"github.com/OWNER/modular-agent/go/vanilla"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestACPTwoFailureKeepsHistoryAndDuplicateResult(t *testing.T) {
	root := t.TempDir()
	h, err := vanilla.New(vanilla.Options{Project: root, History: t.TempDir(), Provider: conformancemodel.Plugin(), Model: conformancemodel.ID, Runtime: durable.Plugin()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	conn, _ := connection(t, h.API(), &client{})
	ctx := timeout(t)
	init, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1, Meta: map[string]json.RawMessage{"modular-agent": api.JSON(map[string]string{"binding": "modular-agent-acp/2"})}})
	if err != nil || api.Decode[map[string]any](init.Meta["modular-agent"])["binding"] != "modular-agent-acp/2" {
		t.Fatalf("initialize /2: %+v %v", init, err)
	}
	opened, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	request := acp.PromptRequest{SessionId: opened.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("fail:conformance failure")}, Meta: map[string]json.RawMessage{"modular-agent": api.JSON(map[string]string{"key": "fail-once"})}}
	type failure struct {
		Meta map[string]struct {
			InputID   string
			Duplicate bool
			Outcome   struct{ Kind, Error string }
		} `json:"_meta"`
	}
	var id string
	for _, duplicate := range []bool{false, true} {
		_, err = conn.Prompt(ctx, request)
		var rpc *acp.RequestError
		if !errors.As(err, &rpc) || rpc.Code != -32000 {
			t.Fatalf("expected failed prompt /2: %v", err)
		}
		d := api.Decode[failure](api.JSON(rpc.Data)).Meta["modular-agent"]
		if d.InputID == "" || duplicate && d.InputID != id || d.Duplicate != duplicate || d.Outcome.Kind != "failed" || d.Outcome.Error != rpc.Message || !strings.Contains(rpc.Message, "conformance failure") {
			t.Fatalf("bad failure response: %+v %v", d, rpc)
		}
		id = d.InputID
	}
	prompt(t, conn, opened.SessionId, "after failure", "")
	snap, err := h.API().Snapshot(string(opened.SessionId))
	if err != nil {
		t.Fatal(err)
	}
	ends := 0
	for _, e := range snap.Entries {
		if e.Kind == "turn.end" {
			ends++
		}
	}
	if ends != 2 {
		t.Fatalf("wanted failed and successful turn, got %d ends", ends)
	}
}

func TestACPLoadRetainsUnavailableModelAndDefaultsApprovalToAll(t *testing.T) {
	for _, approval := range []string{"", "foreign-policy"} {
		name := approval
		if name == "" {
			name = "missing policy"
		}
		t.Run(name, func(t *testing.T) {
			const id = "foreign-settings"
			const path = "/v1/sessions/" + id
			root := t.TempDir()
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
					t.Fatal(err)
				}
			}
			var out any
			call("PUT", path, map[string]any{"project": root, "created": 1000}, &out)
			var lease struct{ Lease string }
			call("POST", path+"/lease", map[string]string{"owner": "peer"}, &lease)
			settings := map[string]any{"model": map[string]string{"provider": "peer", "id": "unknown"}}
			if approval != "" {
				settings["approval"] = approval
			}
			entries := []json.RawMessage{
				json.RawMessage(`{"id":"foreign","parentId":null,"kind":"actorJoined","sessionId":"foreign-settings","time":1001,"writer":"peer","modelVisible":false,"data":{"actor":{"id":"foreign-owner","kind":"host","rights":["watch"]}}}`),
				api.JSON(map[string]any{"id": "settings", "parentId": "foreign", "kind": "setting", "sessionId": id, "time": 1002, "writer": "peer", "modelVisible": false, "data": map[string]any{"key": "settings", "value": settings}}),
			}
			call("POST", path+"/entries", map[string]any{"entries": entries, "lease": lease.Lease}, &out)
			call("DELETE", path+"/lease/"+lease.Lease, nil, &out)

			h, err := vanilla.New(vanilla.Options{Project: root, History: t.TempDir(), Store: historyhttp.Plugin(wire), Provider: conformancemodel.Plugin(), Model: conformancemodel.ID, Runtime: durable.Plugin()})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { h.Close() })
			c := &client{}
			conn, _ := connection(t, h.API(), c)
			initClient(t, conn, false)
			loaded, err := conn.LoadSession(ctx, acp.LoadSessionRequest{SessionId: id, Cwd: root})
			if err != nil {
				t.Fatal(err)
			}
			values := map[acp.SessionConfigId]acp.SessionConfigValueId{}
			for _, o := range loaded.ConfigOptions {
				values[o.Select.Id] = o.Select.CurrentValue
			}
			want := acp.SessionConfigValueId("all")
			if approval != "" {
				want = "never"
			}
			if values["model"] != "peer/unknown" || values["approval"] != want {
				t.Fatalf("unexpected settings: %+v", values)
			}
			r, err := conn.Prompt(ctx, acp.PromptRequest{SessionId: id, Prompt: []acp.ContentBlock{acp.TextBlock("no substitution")}})
			if err != nil || r.StopReason != acp.StopReasonRefusal || !strings.Contains(string(r.Meta["modular-agent"]), "peer/unknown") {
				t.Fatalf("unavailable prompt: %+v %v", r, err)
			}
			if _, err := conn.SetSessionConfigOption(ctx, acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: id, ConfigId: "model", Value: conformancemodel.ID}}); err != nil {
				t.Fatal(err)
			}
			prompt(t, conn, id, `tool:bash {"command":"echo unsafe > refused.txt"}`, "")
			if _, err := os.Stat(filepath.Join(root, "refused.txt")); !os.IsNotExist(err) {
				t.Fatal("approval default did not fail closed", err)
			}
			snap, err := h.API().Snapshot(id)
			if err != nil || snap.Actors["foreign-owner"].Kind != "host" || snap.Actors["local-user"].Kind != "host" {
				t.Fatalf("reopen replaced the foreign owner: %+v %v", snap.Actors, err)
			}
		})
	}
}
