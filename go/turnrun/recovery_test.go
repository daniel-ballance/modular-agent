package turnrun_test

import (
	"context"
	"fmt"
	"modular/api"
	"modular/durable"
	"modular/fake"
	"modular/internal/proctest"
	"modular/vanilla"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type effectTools struct{ root, cut string }

func (s effectTools) Tools(api.Session) []api.Tool {
	var out []api.Tool
	for _, name := range []string{"done", "safe", "unsafe", "tail"} {
		out = append(out, api.Tool{Name: name, Input: api.JSON(map[string]any{"type": "object"}), SafeRepeat: name == "done" || name == "safe"})
	}
	return out
}
func (s effectTools) Run(ctx context.Context, _ api.Session, call api.Call, _ func(string)) api.ToolResult {
	f, err := os.OpenFile(filepath.Join(s.root, "effects"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		panic(err)
	}
	_, err = f.WriteString(call.Name + "\n")
	if err == nil {
		err = f.Sync()
	}
	_ = f.Close()
	if err != nil {
		panic(err)
	}
	if s.cut == "effect-"+call.Name {
		pause(s.root)
	}
	return api.ToolResult{Call: call.ID, Status: "completed", Content: api.Text("effect " + call.Name)}
}
func pause(root string) {
	if err := os.WriteFile(filepath.Join(root, "ready"), []byte("ready"), 0600); err != nil {
		panic(err)
	}
	for {
		time.Sleep(time.Hour)
	}
}
func firstResponse() api.Response {
	var content api.Content
	for _, name := range []string{"done", "safe", "unsafe", "tail"} {
		content = append(content, api.Part{Type: "tool_call", Call: &api.Call{ID: name, Name: name, Input: api.JSON(map[string]string{})}})
	}
	return api.Response{Content: content, Stop: "tools", Usage: api.Usage{Input: 11, Output: 3}}
}
func fakeOptions(root string, p *fake.Provider, isDurable bool) vanilla.Options {
	opt := vanilla.Options{History: filepath.Join(root, "history"), Global: filepath.Join(root, "absent"), Model: "fake", Provider: p.Plugin()}
	if isDurable {
		opt.Runtime = durable.Plugin()
	}
	return opt
}
func installEffects(t *testing.T, h interface{ Load(api.Plugin) error }, root, cut string) {
	t.Helper()
	if err := h.Load(api.Plugin{Name: "effects", Setup: func(a api.API) error { return a.Provide("tools.effects", effectTools{root, cut}) }}); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeSIGKILLRecovery(t *testing.T) {
	if root := os.Getenv("MODULAR_CRASH_ROOT"); root != "" {
		cut := os.Getenv("MODULAR_CRASH_CUT")
		p := fake.New(fake.Script{Response: firstResponse()}, fake.Script{Response: api.Response{Content: api.Text("continued"), Stop: "finished", Usage: api.Usage{Input: 5, Output: 2}}})
		h, err := vanilla.New(fakeOptions(root, p, false))
		if err != nil {
			t.Fatal(err)
		}
		installEffects(t, h, root, cut)
		id, err := h.API().New(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, "session"), []byte(id), 0600); err != nil {
			t.Fatal(err)
		}
		models := 0
		h.API().Subscribe(func(event api.Event) {
			if event.Kind != "history.added" {
				return
			}
			e := api.Decode[api.Entry](event.Data)
			if e.Kind == "model" {
				models++
			}
			match := e.Kind == cut || cut == e.Kind+":"+e.Call
			if cut == "final-model" {
				match = e.Kind == "model" && models == 2
			}
			if cut == "final-checkpoint" {
				match = e.Kind == "step.end" && !api.Decode[struct{ Continue bool }](e.Data).Continue
			}
			if match {
				pause(root)
			}
		})
		_, err = h.API().Submit(context.Background(), id, api.Input{Key: "original", Content: api.Text("go")})
		if err != nil {
			t.Fatal(err)
		}
		_, _ = h.API().Wait(context.Background(), id)
		t.Fatal("crash boundary was not reached")
	}
	for _, runtimeName := range []string{"transient", "durable"} {
		t.Run(runtimeName, func(t *testing.T) {
			for _, cut := range []string{"turn.start", "step.start", "model", "tool.call:tail", "effect-safe", "effect-unsafe", "tool.result:unsafe", "step.end", "final-model", "final-checkpoint"} {
				t.Run(cut, func(t *testing.T) {
					root := t.TempDir()
					cmd := exec.Command(os.Args[0], "-test.run=^TestRuntimeSIGKILLRecovery$")
					cmd.Env = append(os.Environ(), "MODULAR_CRASH_ROOT="+root, "MODULAR_CRASH_CUT="+cut)
					var stderr strings.Builder
					cmd.Stderr = &stderr
					if err := cmd.Start(); err != nil {
						t.Fatal(err)
					}
					waited := false
					defer func() {
						if !waited {
							_ = cmd.Process.Kill()
							_ = cmd.Wait()
						}
					}()
					proctest.Await(t, func() bool { _, err := os.Stat(filepath.Join(root, "ready")); return err == nil })
					if err := cmd.Process.Kill(); err != nil {
						t.Fatal(err)
					}
					if err := cmd.Wait(); err == nil {
						t.Fatal("child was not killed")
					}
					waited = true
					idBytes, err := os.ReadFile(filepath.Join(root, "session"))
					if err != nil {
						t.Fatal(err)
					}
					id := string(idBytes)
					before, _ := os.ReadFile(filepath.Join(root, "effects"))
					scripts := []fake.Script{{Require: "effect", Response: api.Response{Content: api.Text("continued"), Stop: "finished", Usage: api.Usage{Input: 5, Output: 2}}}}
					if cut == "turn.start" || cut == "step.start" {
						scripts = append([]fake.Script{{Response: firstResponse()}}, scripts...)
					}
					if cut == "final-model" || cut == "final-checkpoint" {
						scripts = nil
					}
					p := fake.New(scripts...)
					h, err := vanilla.New(fakeOptions(root, p, runtimeName == "durable"))
					if err != nil {
						t.Fatal(err)
					}
					defer h.Close()
					installEffects(t, h, root, "")
					if err = h.API().Open(context.Background(), id); err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					out, err := h.API().Wait(ctx, id)
					if err != nil {
						t.Fatal(err, stderr.String())
					}
					want := "completed"
					if runtimeName == "transient" {
						want = "failed"
					}
					if out.Status != want {
						t.Fatal(out, stderr.String())
					}
					snap, _ := h.API().Snapshot(id)
					results := map[string][]api.ToolResult{}
					starts, ends := 0, 0
					for _, e := range snap.Branch() {
						switch e.Kind {
						case "tool.result":
							results[e.Call] = append(results[e.Call], api.Decode[api.ToolResult](e.Data))
						case "turn.start":
							starts++
						case "turn.end":
							ends++
						}
					}
					if starts != 1 || ends != 1 {
						t.Fatal("turn identity changed", starts, ends)
					}
					if runtimeName == "durable" {
						if out.Result.Text() != "continued" || out.Steps != 2 || out.Usage.Input != 16 || out.Usage.Output != 5 {
							t.Fatal(out)
						}
						for _, name := range []string{"done", "safe", "unsafe", "tail"} {
							if len(results[name]) != 1 {
								t.Fatal(name, results)
							}
						}
						if cut == "effect-unsafe" {
							r := results["unsafe"][0]
							if r.Status != "unknown" || !strings.Contains(r.Content.Text(), "did not finish") || !strings.Contains(r.Content.Text(), "Check outside state") {
								t.Fatal(r)
							}
							if !strings.Contains(string(api.JSON(p.Requests())), "outcome is unknown") {
								t.Fatal("model did not see unknown outcome")
							}
						}
					} else {
						if len(p.Requests()) != 0 {
							t.Fatal("transient made a model request")
						}
						if cut != "turn.start" && cut != "step.start" {
							for _, name := range []string{"done", "safe", "unsafe", "tail"} {
								if len(results[name]) != 1 {
									t.Fatal(name, results)
								}
							}
						}
						if cut == "effect-safe" && (results["safe"][0].Status != "unknown" || results["unsafe"][0].Status != "not_started") {
							t.Fatal(results)
						}
					}
					after, _ := os.ReadFile(filepath.Join(root, "effects"))
					if runtimeName == "transient" && string(after) != string(before) {
						t.Fatal("transient repeated outside effects")
					}
					if runtimeName == "durable" {
						for _, name := range []string{"done", "safe", "unsafe", "tail"} {
							wantCount := 1
							if name == "safe" && cut == "effect-safe" {
								wantCount = 2
							}
							got := 0
							for _, line := range strings.Split(string(after), "\n") {
								if line == name {
									got++
								}
							}
							if got != wantCount {
								t.Fatal(fmt.Sprintf("%s ran %d times, want %d: %s", name, got, wantCount, after))
							}
						}
					}
					// Reopening again is inert; completed results and outcome remain single.
					if err = h.API().CloseSession(id); err != nil {
						t.Fatal(err)
					}
					if err = h.API().Open(ctx, id); err != nil {
						t.Fatal(err)
					}
					again, _ := h.API().Wait(ctx, id)
					if again.Status != want {
						t.Fatal(again)
					}
				})
			}
		})
	}
}
