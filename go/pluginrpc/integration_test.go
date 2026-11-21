package pluginrpc_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A real process, not an in-process stand-in for the transport. The independent
// fixture below deliberately constructs wire JSON without the binding codecs.
func TestBindingChild(t *testing.T) {
	mode := os.Getenv("GO_PLUGIN_FIXTURE")
	if mode == "" {
		return
	}
	if mode == "conformance" {
		if err := pluginrpc.ConformanceServer().Serve(context.Background(), os.Stdin, os.Stdout); err != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
	peer := pluginrpc.NewPeer(os.Stdin, os.Stdout)
	if mode == "rewind-points" {
		peer.Handle = rewindFixture(peer)
		_ = peer.Run()
		os.Exit(0)
	}
	changed := atomic.Bool{}
	tools := func() []any {
		if mode == "callers" {
			return []any{map[string]any{"name": "ui-only", "callers": []string{"ui"}, "parameters": map[string]any{"type": "object"}}}
		}
		name := "probe"
		if mode == "collision-with-replacement" {
			name = "read"
		}
		list := []any{map[string]any{"name": name, "description": "binding probe", "parameters": map[string]any{"type": "object"}, "hints": map[string]any{"safeToRepeat": true}}}
		if changed.Load() {
			list = append(list, map[string]any{"name": "added", "parameters": map[string]any{"type": "object"}})
		}
		return list
	}
	peer.Handle = func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		var p map[string]any
		_ = json.Unmarshal(raw, &p)
		switch method {
		case "plugin/initialize":
			if mode == "environment" || mode == "missing-environment" || mode == "broken-environment" {
				return map[string]any{"binding": pluginrpc.Binding, "name": "virtual-environment", "workingEnvironment": map[string]any{"containment": "none", "platforms": []string{"linux"}}, "replaces": []string{"working-environment"}}, nil
			}
			reg := map[string]any{"binding": pluginrpc.Binding, "name": "wire-fixture", "toolSources": []any{map[string]any{"id": "fixture", "tools": tools(), "perSession": true}}, "commands": []any{map[string]any{"name": "fixture", "description": "probe commands"}}}
			if mode == "duplicate-tool" {
				delete(reg, "commands")
			}
			if mode == "invalid-replace" {
				reg["replaces"] = []string{"tool:no-such-tool"}
			}
			if mode == "collision-with-replacement" {
				reg["replaces"] = []string{"working-environment"}
				reg["workingEnvironment"] = map[string]any{"containment": "none", "platforms": []string{"linux"}}
			}
			if mode == "credentials" {
				reg["providers"] = []any{map[string]any{"id": "fixture"}, map[string]any{"id": "no-credential"}}
			}
			if mode == "unsupported" {
				reg["hooks"] = []any{map[string]any{"handlerId": 1, "hook": "fixture.unknown", "order": "normal"}}
			}
			if mode == "probe-output" {
				reg["hooks"] = []any{map[string]any{"handlerId": 4, "hook": "output", "order": "normal"}}
			}
			if mode == "hooks" {
				reg["hooks"] = []any{map[string]any{"handlerId": 1, "hook": "provider.request", "order": "normal"}, map[string]any{"handlerId": 2, "hook": "step.after", "order": "normal"}, map[string]any{"handlerId": 3, "hook": "turn.before", "order": "normal"}}
			}
			return reg, nil
		case "plugin/shutdown":
			if path := os.Getenv("GO_PLUGIN_SHUTDOWN"); path != "" {
				if err := os.WriteFile(path, api.JSON(p), 0600); err != nil {
					return nil, err
				}
			}
			return map[string]any{}, nil
		case "env/sessionEnded":
			if path := os.Getenv("GO_PLUGIN_SESSION_ENDED"); path != "" {
				if err := os.WriteFile(path, api.JSON(p), 0600); err != nil {
					return nil, err
				}
			}
			return map[string]any{}, nil
		case "env/exists":
			return map[string]any{"exists": true}, nil
		case "env/read":
			if mode == "missing-environment" || mode == "broken-environment" {
				failure := &pluginrpc.RPCError{Number: -32000, Message: "archivo ausente"}
				failure.Data.Code = "not_found"
				if mode == "broken-environment" {
					failure.Message = "No such file or directory"
					failure.Data.Code = "internal"
				}
				return nil, failure
			}
			return map[string]any{"data": base64.StdEncoding.EncodeToString([]byte("virtual-file-from-other-environment"))}, nil
		case "tools/list":
			return map[string]any{"tools": tools()}, nil
		case "command/run":
			if mode == "credentials" {
				var result struct {
					Credential map[string]string `json:"credential"`
				}
				if err := peer.Call(ctx, "host/credentials/read", map[string]any{"provider": "fixture"}, &result); err != nil {
					return nil, err
				}
				if result.Credential["type"] != "apiKey" || result.Credential["key"] != fakeCredential {
					return nil, errors.New("credential did not have the expected shared shape")
				}
				if err := peer.Call(ctx, "host/credentials/read", map[string]any{"provider": "no-credential"}, &result); err != nil || result.Credential != nil {
					return nil, errors.New("missing credential was not null")
				}
				for _, p := range []map[string]any{
					{"provider": "unowned"},
					{"provider": "fixture", "parentRequestId": pluginrpc.RequestID(ctx)},
				} {
					if err := peer.Call(ctx, "host/credentials/read", p, nil); pluginrpc.Code(err) != "invalid_request" {
						return nil, errors.New("credential callback did not enforce authority")
					}
				}
				return map[string]any{"output": "credential callbacks passed"}, nil
			}
			return map[string]any{"output": "external command: " + fmt.Sprint(p["args"])}, nil
		case "hook/handle":
			payload, _ := p["payload"].(map[string]any)
			switch p["handlerId"] {
			case float64(1):
				request := payload["request"].(map[string]any)
				messages := request["messages"].([]any)
				if !strings.Contains(fmt.Sprint(request["systemPrompt"]), "fixture collect") {
					return nil, errors.New("missing collected system prompt")
				}
				if !strings.Contains(fmt.Sprint(messages), "fixture context") {
					return nil, errors.New("missing collected context")
				}
				request["messages"] = []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "changed by provider hook"}}}}
				return map[string]any{"value": payload}, nil
			case float64(2):
				return map[string]any{"refuse": "step gate ended turn"}, nil
			case float64(3):
				return map[string]any{"system": "fixture collect", "context": []any{map[string]any{"type": "text", "text": "fixture context"}}}, nil
			case float64(4):
				events, _ := payload["events"].([]any)
				for _, raw := range events {
					event := raw.(map[string]any)
					if event["type"] == "plugin.problem" {
						// A hook reply has no tool stream. A mismatched notification
						// must not make this reply wait behind the gate itself.
						if err := peer.Send("tools/progress", map[string]any{
							"parentRequestId": pluginrpc.RequestID(ctx), "content": []any{},
						}); err != nil {
							return nil, err
						}
						event["data"] = "gated problem"
					}
				}
				return map[string]any{"events": events}, nil
			}
		case "tools/call":
			call := p["call"].(map[string]any)
			input, _ := call["input"].(map[string]any)
			if call["name"] == "ui-only" {
				return map[string]any{"status": "completed", "content": []any{map[string]any{"type": "text", "text": "UI called it"}}}, nil
			}
			if input["lose"] == true {
				os.Exit(0)
			}
			parent := pluginrpc.RequestID(ctx)
			ask := func(method string, args map[string]any) (map[string]any, error) {
				args["parentRequestId"] = parent
				if strings.HasPrefix(method, "host/env/") {
					args["sessionId"] = p["sessionId"]
				}
				var answer map[string]any
				err := peer.Call(ctx, method, args, &answer)
				return answer, err
			}
			if input["defer"] == true {
				answer, err := ask("host/ask", map[string]any{"request": map[string]any{"kind": "text", "question": "late marker", "timeLimitMs": 10, "whenTimeLimit": "leaveOpen"}})
				if err != nil {
					return nil, err
				}
				if answer["pending"] == true {
					return map[string]any{"pending": "waiting for marker"}, nil
				}
				return map[string]any{"status": "completed", "content": []any{map[string]any{"type": "text", "text": answer["value"]}}}, nil
			}
			if input["readMissing"] == true {
				_, err := ask("host/env/read", map[string]any{"cwd": p["project"], "path": "AGENTS.md"})
				return map[string]any{"status": "completed", "content": []any{map[string]any{"type": "text", "text": pluginrpc.Code(err)}}}, nil
			}
			checks := []string{}
			for _, method := range []string{"host/session", "host/history", "host/declaration"} {
				value, err := ask(method, map[string]any{"sessionId": p["sessionId"], "limit": 1})
				if err != nil {
					return nil, err
				}
				if len(value) == 0 {
					return nil, errors.New("empty " + method)
				}
				checks = append(checks, method)
			}
			// Unknown history cursors and forged session/lineage must not be accepted.
			_, err := ask("host/history", map[string]any{"sessionId": p["sessionId"], "after": "not-recorded"})
			if pluginrpc.Code(err) != "invalid_request" {
				return nil, fmt.Errorf("bad cursor accepted: %v", err)
			}
			_, err = ask("host/session", map[string]any{"sessionId": "forged"})
			if pluginrpc.Code(err) != "invalid_request" {
				return nil, fmt.Errorf("forged session accepted: %v", err)
			}
			_, err = ask("host/hook", map[string]any{"hook": "provider.request", "payload": map[string]any{}})
			if pluginrpc.Code(err) != "invalid_request" {
				return nil, fmt.Errorf("unowned hook accepted: %v", err)
			}
			_, err = ask("host/credentials/read", map[string]any{"provider": "unowned"})
			if pluginrpc.Code(err) != "invalid_request" {
				return nil, fmt.Errorf("unowned credential accepted: %v", err)
			}
			var bogus any
			err = peer.Call(ctx, "host/env/read", map[string]any{"parentRequestId": 999999, "path": "file", "cwd": p["project"]}, &bogus)
			if pluginrpc.Code(err) != "invalid_request" {
				return nil, fmt.Errorf("unowned work accepted: %v", err)
			}
			cwd := p["project"]
			_, err = ask("host/env/write", map[string]any{"cwd": cwd, "path": "host-file.txt", "data": base64.StdEncoding.EncodeToString([]byte("callback-file"))})
			if err != nil {
				return nil, err
			}
			exists, err := ask("host/env/exists", map[string]any{"cwd": cwd, "path": "host-file.txt"})
			if err != nil || exists["exists"] != true {
				return nil, fmt.Errorf("exists: %v %v", exists, err)
			}
			read, err := ask("host/env/read", map[string]any{"cwd": cwd, "path": "host-file.txt"})
			if err != nil || read["data"] != base64.StdEncoding.EncodeToString([]byte("callback-file")) {
				return nil, fmt.Errorf("read: %v %v", read, err)
			}
			_, err = ask("host/env/exec", map[string]any{"cwd": cwd, "command": "printf callback-exec; exit 7"})
			if err != nil {
				return nil, err
			}
			answer, err := ask("host/ask", map[string]any{"request": map[string]any{"kind": "text", "question": "fixture asks", "timeLimitMs": 1, "whenTimeLimit": "decline"}})
			if err != nil || answer["declined"] != true {
				return nil, fmt.Errorf("ask: %v %v", answer, err)
			}
			_ = peer.Send("host/emit", map[string]any{"sessionId": p["sessionId"], "type": "probe.notice", "data": "emitted"})
			_ = peer.Send("host/problem", map[string]any{"where": "fixture", "message": "reported problem"})
			changed.Store(true)
			_ = peer.Send("tools/changed", map[string]any{"toolSource": "fixture", "parentRequestId": pluginrpc.RequestID(ctx)})
			return map[string]any{"status": "completed", "content": []any{map[string]any{"type": "text", "text": strings.Join(checks, ",")}}, "futureResult": map[string]any{"kept": true}}, nil
		}
		return nil, errors.New("fixture method: " + method)
	}
	_ = peer.Run()
	os.Exit(0)
}
func childSpec(mode, parts string) map[string]any {
	exe, _ := os.Executable()
	return map[string]any{"command": []string{exe, "-test.run=^TestBindingChild$"}, "env": map[string]string{"GO_PLUGIN_FIXTURE": mode, "MODULAR_AGENT_PLUGIN_PARTS": parts}}
}
func options(t *testing.T) vanilla.Options {
	t.Helper()
	root := t.TempDir()
	return vanilla.Options{Project: t.TempDir(), DataDir: root, History: filepath.Join(root, "history"), Global: filepath.Join(root, "settings"), Provider: conformancemodel.Plugin(), Model: conformancemodel.ID}
}

type poisonEnvironment struct {
	calls  atomic.Int64
	closed atomic.Bool
}

func (e *poisonEnvironment) StopsOnCrash() bool { e.calls.Add(1); return false }
func (e *poisonEnvironment) Read(context.Context, string, string) ([]byte, error) {
	e.calls.Add(1)
	return nil, errors.New("local environment must be absent")
}
func (e *poisonEnvironment) Write(context.Context, string, string, []byte) error {
	e.calls.Add(1)
	return errors.New("local environment must be absent")
}
func (e *poisonEnvironment) Bash(context.Context, string, string, func(string)) (string, error) {
	e.calls.Add(1)
	return "", errors.New("local environment must be absent")
}
func (e *poisonEnvironment) Close() error { e.closed.Store(true); return nil }

func TestPluginEOFStopsAnActiveEscapedCommand(t *testing.T) {
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "-test.run=^TestBindingChild$")
	cmd.Env = append(os.Environ(), "GO_PLUGIN_FIXTURE=conformance", "MODULAR_AGENT_PLUGIN_PARTS=environment")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	peer := pluginrpc.NewPeer(output, input)
	ready := make(chan struct{}, 1)
	peer.Notify = func(method string, raw json.RawMessage) {
		if method == "env/output" && strings.Contains(string(raw), "ready") {
			select {
			case ready <- struct{}{}:
			default:
			}
		}
	}
	done := make(chan struct{})
	go func() { _ = peer.Run(); close(done) }()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() {
		input.Close()
		peer.Close()
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-exited
		}
		<-done
	})
	project := t.TempDir()
	if err = peer.Call(context.Background(), "plugin/initialize", map[string]any{"binding": pluginrpc.Binding, "data": pluginrpc.DataBinding, "project": project, "home": t.TempDir()}, nil); err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = peer.Call(context.Background(), "env/exec", map[string]any{"cwd": project, "sessionId": "eof-test", "command": "setsid bash -c 'sleep 2; echo survived > escaped.txt' & echo ready; sleep 30"}, nil)
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("command never started", stderr.String())
	}
	input.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("plugin did not stop active work on EOF")
	}
	time.Sleep(2200 * time.Millisecond)
	if _, err = os.Stat(filepath.Join(project, "escaped.txt")); !os.IsNotExist(err) {
		t.Fatal("an escaped descendant outlived the plugin", err)
	}
}

func TestExternalItemsReplaceRatherThanShadowLocalCopies(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "provider,hooks"), childSpec("conformance", "tools,environment")})))
	runtimetest.Each(t, func(t *testing.T) {
		opt := options(t)
		opt.Runtime = runtimetest.Plugin(t)
		env := &poisonEnvironment{}
		opt.Environment = api.Plugin{Name: "poison-environment", Setup: func(a api.API) error { return a.Provide("working-environment", env) }, Close: env.Close}
		original := conformancemodel.New()
		opt.Provider = api.Plugin{Name: "original-provider", Setup: func(a api.API) error { return a.Provide("provider.conformance", original) }}
		h, err := vanilla.New(opt)
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a := h.API()
		providers := a.All("provider.")
		if len(providers) != 1 || providers[0] == original {
			t.Fatal("local provider was retained", providers)
		}
		actual, _ := a.Get("working-environment")
		if actual == env || !env.closed.Load() {
			t.Fatal("local environment was retained")
		}
		builtin, _ := a.Get("tools.builtin")
		for _, def := range builtin.(api.ToolSource).Tools(api.Session{}) {
			if def.Name == "read" || def.Name == "bash" {
				t.Fatal("local tool was shadowed rather than removed", def.Name)
			}
		}
		counts := map[string]int{}
		for _, source := range a.All("tools.") {
			for _, def := range source.(api.ToolSource).Tools(api.Session{}) {
				counts[def.Name]++
			}
		}
		if counts["read"] != 1 || counts["bash"] != 1 || counts["write"] != 1 || counts["edit"] != 1 {
			t.Fatal(counts)
		}
		id, err := a.New(context.Background(), opt.Project)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(opt.Project, "note.txt"), []byte("external-marker"), 0600); err != nil {
			t.Fatal(err)
		}
		_, err = a.Submit(context.Background(), id, api.Input{Content: api.Text(`tool:read {"path":"note.txt"}`)})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := a.Wait(ctx, id)
		if err != nil || out.Status != "completed" || out.Result.Text() != "done: external-marker" {
			t.Fatal(out, err)
		}
		if env.calls.Load() != 0 {
			t.Fatal("original environment was used")
		}
	})
}
func TestToolsUseTheSelectedEnvironmentInAnotherProcess(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "tools"), childSpec("environment", "")})))
	opt := options(t)
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	id, err := h.API().New(context.Background(), opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	r, err := h.API().CallTool(context.Background(), id, api.Call{Name: "read", Input: api.JSON(map[string]string{"path": "not-on-local-disk"})})
	if err != nil || r.Status != "completed" || r.Content.Text() != "virtual-file-from-other-environment" {
		t.Fatal(r, err)
	}
}
func TestHostCallbacksCommandsChangedListsAndLostTools(t *testing.T) {
	testHostCallbacks(t, "probe")
}

func TestHostProblemThroughOwnOutputGate(t *testing.T) {
	testHostCallbacks(t, "probe-output")
}

func testHostCallbacks(t *testing.T, mode string) {
	t.Helper()
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec(mode, "")})))
	opt := options(t)
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	a := h.API()
	id, err := a.New(context.Background(), opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	notifications := make(chan string, 2)
	a.Subscribe(func(e api.Event) {
		if e.Kind == "plugin.wire-fixture.probe.notice" || e.Kind == "plugin.problem" &&
			(mode != "probe-output" || string(e.Data) == `"gated problem"`) {
			notifications <- e.Kind
		}
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := a.CallTool(ctx, id, api.Call{Name: "probe", Input: api.JSON(map[string]any{})})
	if err != nil || result.Status != "completed" {
		t.Fatal(result, err)
	}
	if !strings.Contains(result.Content.Text(), "host/history") || !strings.Contains(string(result.Wire), "futureResult") {
		t.Fatal(result)
	}
	found := false
	for _, source := range a.All("tools.") {
		for _, tool := range source.(api.ToolSource).Tools(api.Session{ID: id}) {
			if tool.Name == "added" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("changed list was not refreshed before returning the result")
	}
	for _, want := range []string{"plugin.wire-fixture.probe.notice", "plugin.problem"} {
		select {
		case got := <-notifications:
			if got != want {
				t.Fatalf("notification = %q, want %q", got, want)
			}
		case <-ctx.Done():
			t.Fatalf("notification %q was not delivered", want)
		}
	}
	if mode == "probe-output" {
		return
	}
	text, err := a.Command(context.Background(), id, "fixture one two")
	if err != nil || text != "external command: [one two]" {
		t.Fatal(text, err)
	}
	result, err = a.CallTool(context.Background(), id, api.Call{Name: "probe", Input: api.JSON(map[string]any{"lose": true})})
	if err != nil || result.Status != "unknown" {
		t.Fatal("lost started call needs exactly one unknown outcome", result, err)
	}
}
func TestRemoteProviderAndTurnHooksUseStandardPayloads(t *testing.T) {
	for _, provider := range []string{"local", "remote"} {
		t.Run(provider, func(t *testing.T) {
			specs := []any{childSpec("hooks", "")}
			if provider == "remote" {
				specs = append([]any{childSpec("conformance", "provider")}, specs...)
			}
			t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON(specs)))
			opt := options(t)
			h, err := vanilla.New(opt)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			a := h.API()
			id, err := a.New(context.Background(), opt.Project)
			if err != nil {
				t.Fatal(err)
			}
			_, err = a.Submit(context.Background(), id, api.Input{Content: api.Text("original")})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			out, err := a.Wait(ctx, id)
			if err != nil || out.Status != "failed" || !strings.Contains(out.Error, "step gate ended turn") {
				t.Fatal(out, err)
			}
			snap, err := a.Snapshot(id)
			if err != nil || !slices.ContainsFunc(snap.Entries, func(e api.Entry) bool {
				return e.Kind == "model" && e.Content.Text() == "echo: changed by provider hook"
			}) {
				t.Fatal("Provider transform was not reflected in the response", err)
			}
		})
	}
}
