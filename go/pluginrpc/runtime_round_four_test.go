package pluginrpc_test

import (
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

type retryProvider struct {
	*fake.Provider
	discarded atomic.Bool
}

type keptStateAccess struct{ api.ModelAccess }

func (a keptStateAccess) Model() api.Model {
	m := a.ModelAccess.Model()
	m.Stateful = true
	return m
}

func (p *retryProvider) Access(id string) (api.ModelAccess, error) {
	a, err := p.Provider.Access(id)
	return keptStateAccess{a}, err
}

func (p *retryProvider) Discard(ctx context.Context, session string) error {
	if session == "" || api.Executing(ctx).Session != session {
		return fmt.Errorf("discard called without the turn's session: %q", session)
	}
	p.discarded.Store(true)
	return nil
}

func TestHostedRuntimeDiscardsProviderStateBeforeRetry(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(fmt.Sprintf("replacement=%t", replace), func(t *testing.T) {
			t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "runtime")})))
			p := &retryProvider{}
			p.Provider = fake.New(
				fake.Script{Err: &api.ModelError{Kind: "unavailable", Message: "please retry"}},
				fake.Script{Run: func(_ context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
					if !p.discarded.Load() {
						return api.Response{}, fmt.Errorf("model retried before provider state was discarded")
					}
					return api.Response{Stop: "finished", Content: api.Text(r.System)}, nil
				}},
			)
			opt := options(t)
			opt.Provider = api.Plugin{Name: "stateful-fake", Setup: func(a api.API) error { return a.Provide("provider.fake", p) }}
			opt.Model = "fake"
			h, err := vanilla.New(opt)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			var prepared int
			if err := h.Load(api.Plugin{Name: "retry-hooks", Setup: func(a api.API) error {
				if err := a.Handle("runtime.step.before", "last", func(_ context.Context, v any) (api.Decision, error) {
					prepared++
					sc := v.(api.StepContext)
					sc.Request.System = fmt.Sprintf("prepared %d", prepared)
					return api.Decision{Value: sc}, nil
				}); err != nil {
					return err
				}
				return a.Handle("runtime.request.failed", "", func(_ context.Context, v any) (api.Decision, error) {
					f := v.(api.Failure)
					f.Retry = true
					if replace {
						f.Context.Request.System = "replacement"
					}
					return api.Decision{Value: f, Answer: true}, nil
				})
			}}); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			id, err := h.API().New(ctx, opt.Project)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := h.API().Submit(ctx, id, api.Input{Content: api.Text("run")}); err != nil {
				t.Fatal(err)
			}
			out, err := h.API().Wait(ctx, id)
			want := "prepared 2"
			if replace {
				want = "replacement"
			}
			if err != nil || out.Status != "completed" || out.Result.Text() != want {
				t.Fatal(out, err)
			}
		})
	}
}

type recoverySource struct{ ran []string }

func (s *recoverySource) Tools(api.Session) []api.Tool {
	return []api.Tool{{Name: "again", SafeRepeat: true}, {Name: "unsafe-now"}, {Name: "fresh", SafeRepeat: true}}
}
func (s *recoverySource) Run(_ context.Context, _ api.Session, c api.Call, _ func(string)) api.ToolResult {
	s.ran = append(s.ran, c.ID)
	return api.ToolResult{Status: "completed", Content: api.Text(c.ID)}
}

func TestHostedRuntimeReopensStandardHistory(t *testing.T) {
	for _, tc := range []struct {
		name, part string
		revoked    bool
	}{
		{"runtime", "runtime", false},
		{"durable-runtime", "durable-runtime", false},
		{"durable-runtime with revoked tools", "durable-runtime", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			part := tc.part
			t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", part)})))
			provider := fake.New(fake.Script{Response: api.Response{Stop: "finished", Content: api.Text("carried on"), Usage: api.Usage{Input: 3}}})
			opt := options(t)
			opt.Provider, opt.Model = provider.Plugin(), "fake"
			id := seedStandardRuntimeHistory(t, opt, tc.revoked)
			h, err := vanilla.New(opt)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			tools := &recoverySource{}
			if err := h.Load(api.Plugin{Name: "recovery-source", Setup: func(a api.API) error { return a.Provide("tools.runtime-test", tools) }}); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.API().Open(ctx, id); err != nil {
				t.Fatal(err)
			}
			out, err := h.API().Wait(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			wantRan := []string(nil)
			want := map[string]string{"already-done": "completed", "yes": "unknown", "no-then": "unknown", "no-now": "unknown", "new": "not_started"}
			if part == "durable-runtime" {
				if tc.revoked {
					want["new"] = "refused"
				} else {
					wantRan = []string{"new"}
					want["new"] = "completed"
					if runtimetest.StopsOnCrash(t, h.API()) {
						wantRan = []string{"yes", "new"}
						want["yes"] = "completed"
					}
				}
				if out.Status != "completed" || out.Result.Text() != "carried on" || out.Steps != 2 || out.Usage.Input != 10 {
					t.Fatal(out)
				}
				var order []string
				for _, msg := range provider.Requests()[0].Messages {
					if msg.Result != nil {
						order = append(order, msg.Result.Call)
					}
				}
				if !slices.Equal(order, []string{"yes", "no-then", "already-done", "no-now", "new"}) {
					t.Fatalf("model result order: %v", order)
				}
			} else if out.Status != "failed" || len(provider.Requests()) != 0 {
				t.Fatal(out, provider.Requests())
			}
			if !slices.Equal(tools.ran, wantRan) {
				snap, _ := h.API().Snapshot(id)
				for _, e := range snap.Entries {
					if e.Kind == "tool.result" {
						t.Logf("call %s result: %s", e.Call, e.Content.Text())
					}
				}
				t.Fatalf("ran %v, want %v", tools.ran, wantRan)
			}
			snap, err := h.API().Snapshot(id)
			if err != nil {
				t.Fatal(err)
			}
			var starts, ends int
			for _, e := range snap.Branch() {
				switch e.Kind {
				case "turn.start":
					starts++
				case "turn.end":
					ends++
				case "runtime.definition", "step.start", "step.end":
					t.Fatal("hosted Runtime wrote a private checkpoint", e.Kind)
				case "tool.result":
					if got := api.Decode[api.ToolResult](e.Data).Status; got != want[e.Call] {
						t.Fatalf("unexpected or repeated result %q: %q, want %q", e.Call, got, want[e.Call])
					}
					delete(want, e.Call)
				}
			}
			if starts != 1 || ends != 1 || len(want) != 0 {
				t.Fatal(starts, ends, want)
			}
		})
	}
}

func seedStandardRuntimeHistory(t *testing.T, opt vanilla.Options, revoked bool) string {
	t.Helper()
	s := api.Session{ID: api.ID(), Version: 1, Project: opt.Project, Actor: "local-user", Settings: api.Settings{Model: "fake", Thinking: "off", MaxSteps: 3, MaxOutput: 100}}
	add := func(kind string, fields map[string]any) {
		t.Helper()
		var parent any
		if s.Position != "" {
			parent = s.Position
		}
		wire := map[string]any{"id": api.ID(), "parentId": parent, "sessionId": s.ID, "turnId": "interrupted-turn", "kind": kind, "writer": "other-build", "time": time.Now().UnixMilli(), "actorId": s.Actor, "modelVisible": false}
		for k, v := range fields {
			wire[k] = v
		}
		e, err := portable.ReadEntry(api.JSON(wire))
		if err != nil {
			t.Fatal(err)
		}
		s.Position = e.ID
		s.Entries = append(s.Entries, e)
	}
	offer := []any{}
	for _, tool := range (&recoverySource{}).Tools(s) {
		offer = append(offer, portable.Tool(tool))
	}
	add("turnStart", map[string]any{"data": map[string]any{"startedBy": map[string]string{"kind": "actor", "id": s.Actor}, "model": map[string]string{"provider": "fake", "id": "fake"}, "tools": offer, "system": "test", "settings": map[string]any{"maxSteps": 3, "reasoning": "off", "approval": "off"}}})
	add("input", map[string]any{"inputId": "original", "modelVisible": true, "message": map[string]any{"role": "user", "content": []any{map[string]string{"type": "text", "text": "do the work"}}}})
	callNames := []string{"again", "again", "again", "unsafe-now", "fresh"}
	callIDs := []string{"yes", "no-then", "already-done", "no-now", "new"}
	add("modelRequest", map[string]any{"stepId": "first-step", "data": map[string]any{
		"model": map[string]string{"provider": "fake", "id": "fake"}, "safeToRepeat": false,
		"tools": []string{"again", "unsafe-now", "fresh"}, "tracksStepAfter": true,
	}})
	var content []any
	for i, id := range callIDs {
		content = append(content, map[string]any{"type": "toolCall", "id": id, "name": callNames[i], "arguments": map[string]any{}})
	}
	add("response", map[string]any{"stepId": "first-step", "modelVisible": true, "message": map[string]any{"role": "assistant", "content": content, "stop": "toolUse", "usage": map[string]int{"input": 7}}})
	for i, id := range callIDs[:4] {
		data := map[string]any{"safeToRepeat": i != 1, "call": map[string]any{"id": id, "name": callNames[i], "startedBy": "model", "input": map[string]any{}}}
		if id == "yes" {
			data["source"] = map[string]any{"plugin": "recovery-source", "toolSource": "runtime-test"}
			data["definition"] = portable.Tool(api.Tool{Name: "again", SafeRepeat: true})
		}
		add("toolStarted", map[string]any{"stepId": "first-step", "toolCallId": id, "data": data})
	}
	add("toolResult", map[string]any{"stepId": "first-step", "toolCallId": "already-done", "modelVisible": true, "data": map[string]string{"status": "completed"}, "message": map[string]any{"role": "toolResult", "toolCallId": "already-done", "toolName": "again", "content": []any{map[string]string{"type": "text", "text": "already done"}}, "isError": false}})
	if revoked {
		add("actorJoined", map[string]any{"data": map[string]any{"actor": map[string]any{"id": s.Actor, "kind": "user", "rights": []string{"watch", "input"}}}})
	}
	store, err := history.New(opt.History)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.Acquire(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Save(s); err != nil {
		t.Fatal(fmt.Errorf("keep fixture: %w", err))
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	return s.ID
}
