package pluginrpc_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func rewindFixture(peer *pluginrpc.Peer) func(context.Context, string, json.RawMessage) (any, error) {
	type obj = map[string]any
	var points sync.Map
	return func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		var p map[string]any
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		session, _ := p["sessionId"].(string)
		cwd, _ := p["cwd"].(string)
		file := filepath.Join(cwd, "tracked")
		switch method {
		case "plugin/initialize":
			tool := obj{"name": "write", "description": "Write the tracked file", "parameters": obj{"type": "object"}}
			if os.Getenv("GO_PLUGIN_FIXTURE_OPEN_WORLD") == "true" {
				tool["hints"] = obj{"openWorld": true}
			}
			return obj{"binding": pluginrpc.Binding, "name": "rewind-fixture", "workingEnvironment": obj{"containment": "none", "platforms": []string{"linux"}, "points": true},
				"toolSources": []any{obj{"id": "fixture", "tools": []any{tool}}}, "replaces": []string{"working-environment", "tool:write"}}, nil
		case "plugin/shutdown", "env/sessionEnded":
			return obj{}, nil
		case "tools/call":
			call := p["call"].(map[string]any)
			input := call["input"].(map[string]any)
			err := peer.Call(ctx, "host/env/write", obj{"sessionId": session, "parentRequestId": pluginrpc.RequestID(ctx),
				"cwd": p["project"], "path": "tracked", "data": base64.StdEncoding.EncodeToString([]byte(input["content"].(string)))}, nil)
			return obj{"status": "completed", "content": []any{}}, err
		case "env/read":
			failure := &pluginrpc.RPCError{Number: -32601, Message: "no file reads in this fixture"}
			failure.Data.Code = "method_not_found"
			return nil, failure
		case "env/write", "env/save", "env/checkPoint", "env/restore":
			if session == "" || !filepath.IsAbs(cwd) {
				return nil, errors.New("expected sessionId and absolute cwd")
			}
			switch method {
			case "env/write":
				if p["path"] != "tracked" {
					return nil, errors.New("unexpected path")
				}
				data, err := base64.StdEncoding.DecodeString(p["data"].(string))
				if err != nil {
					return nil, err
				}
				return obj{}, os.WriteFile(file, data, 0600)
			case "env/save":
				data, err := os.ReadFile(file)
				if err != nil {
					return nil, err
				}
				point := "fixture-" + api.ID()
				points.Store([3]string{session, cwd, point}, data)
				return obj{"point": point}, nil
			case "env/checkPoint":
				_, ok := points.Load([3]string{session, cwd, p["point"].(string)})
				return obj{"exists": ok}, nil
			case "env/restore":
				data, ok := points.Load([3]string{session, cwd, p["point"].(string)})
				if !ok {
					return nil, fs.ErrNotExist
				}
				return obj{}, os.WriteFile(file, data.([]byte), 0600)
			}
		}
		return nil, fmt.Errorf("unexpected %s", method)
	}
}

func TestRewindWithExternalEnvironmentAndTool(t *testing.T) {
	for _, openWorld := range []string{"true", "omitted"} {
		t.Run(openWorld, func(t *testing.T) {
			t.Setenv("GO_PLUGIN_FIXTURE_OPEN_WORLD", openWorld)
			t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("rewind-points", "")})))
			opt := options(t)
			file := filepath.Join(opt.Project, "tracked")
			if err := os.WriteFile(file, []byte("one"), 0600); err != nil {
				t.Fatal(err)
			}
			h, err := vanilla.New(opt)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			a := h.API()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			id, err := a.New(ctx, opt.Project)
			if err != nil {
				t.Fatal(err)
			}
			runtimetest.Publish(t, a, id)
			mark, err := a.Record(ctx, id, api.Entry{Kind: "test.mark"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := a.Submit(ctx, id, api.Input{Content: api.Text(`tool:write {"path":"tracked","content":"two"}`)}); err != nil {
				t.Fatal(err)
			}
			if out, err := a.Wait(ctx, id); err != nil || out.Status != "completed" {
				t.Fatal(out, err)
			}
			if data, err := os.ReadFile(file); err != nil || string(data) != "two" {
				t.Fatalf("external tool did not write: %q, %v", data, err)
			}
			if err := a.Move(ctx, id, mark.ID, true); err != nil {
				t.Fatal(err)
			}
			if data, err := os.ReadFile(file); err != nil || string(data) != "one" {
				t.Fatalf("external environment did not restore its point: %q, %v", data, err)
			}
			if after, err := a.Snapshot(id); err != nil || after.Position != mark.ID {
				t.Fatalf("did not move to %s: %s, %v", mark.ID, after.Position, err)
			}
		})
	}
}

func TestExternalEnvironmentOwnsRewindPointsAcrossHostRestart(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "environment,runtime")})))
	opt := options(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := func() api.API {
		t.Helper()
		h, err := vanilla.New(opt)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = h.Close() })
		return h.API()
	}
	a := start()
	if acpinterface.Declaration(a, opt.Project, "")["rewinding"] != true {
		t.Fatal("selected external environment did not declare rewind")
	}
	id, err := a.New(ctx, opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	runtimetest.Publish(t, a, id)
	value, _ := a.Get("working-environment")
	points, _ := api.Points(value.(api.WorkingEnvironment))
	if err = points.RestorePoint(api.WithExecution(ctx, api.Execution{Session: id}), opt.Project, "unknown-point"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("served environment should answer not_found: %v", err)
	}
	mark, err := a.Record(ctx, id, api.Entry{Kind: "test.mark"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Submit(ctx, id, api.Input{Content: api.Text(`tool:write {"path":"remote","content":"from plugin"}`)}); err != nil {
		t.Fatal(err)
	}
	if out, err := a.Wait(ctx, id); err != nil || out.Status != "completed" {
		t.Fatal(out, err)
	}
	// A UI call must still run in the host while the Runtime is external.
	if result, err := a.CallTool(ctx, id, api.Call{Name: "write", Input: api.JSON(map[string]string{"path": "from-ui", "content": "local call"})}); err != nil || result.Status != "completed" {
		t.Fatal(result, err)
	}
	if err := a.CloseSession(id); err != nil {
		t.Fatal(err)
	}
	reopened := start()
	if err := reopened.Open(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Move(ctx, id, mark.ID, true); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"remote", "from-ui"} {
		if _, err := os.Stat(filepath.Join(opt.Project, name)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s still exists after rewind: %v", name, err)
		}
	}
	if _, err := reopened.CallTool(ctx, id, api.Call{Name: "write", Input: api.JSON(map[string]string{"path": "remote", "content": "owned by external env"})}); err != nil {
		t.Fatal(err)
	}
	if err := reopened.CloseSession(id); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODULAR_AGENT_PLUGINS", "[]")
	foreign := start()
	if err := foreign.Open(ctx, id); err != nil {
		t.Fatal(err)
	}
	before, _ := foreign.Snapshot(id)
	if err := foreign.Move(ctx, id, mark.ID, true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected missing foreign point: %v", err)
	}
	after, _ := foreign.Snapshot(id)
	if data, err := os.ReadFile(filepath.Join(opt.Project, "remote")); err != nil || string(data) != "owned by external env" || after.Position != before.Position {
		t.Fatalf("foreign point refusal changed state: %q, %v, %s vs %s", data, err, after.Position, before.Position)
	}
}
