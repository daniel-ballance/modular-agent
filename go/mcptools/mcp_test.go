package mcptools_test

import (
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/mcptools"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func server() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	mcp.AddTool(s, &mcp.Tool{Name: "echo", Description: "echo a value", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: ptr(false), OpenWorldHint: ptr(false)}}, func(ctx context.Context, req *mcp.CallToolRequest, in struct {
		Value string `json:"value"`
	}) (*mcp.CallToolResult, map[string]any, error) {
		req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: req.Params.GetProgressToken(), Progress: 1, Message: "live echo"})
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: in.Value}, &mcp.ImageContent{Data: []byte("image"), MIMEType: "image/png"}}}, map[string]any{"value": in.Value, "pid": os.Getpid()}, nil
	})
	mcp.AddTool(s, &mcp.Tool{Name: "effect", Annotations: &mcp.ToolAnnotations{IdempotentHint: true}}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "intentional tool failure"}}}, nil, nil
	})
	mcp.AddTool(s, &mcp.Tool{Name: "plain"}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{}, nil, nil
	})
	mcp.AddTool(s, &mcp.Tool{Name: "slow"}, func(ctx context.Context, req *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: req.Params.GetProgressToken(), Progress: 0, Message: "started slow"})
		<-ctx.Done()
		return nil, nil, ctx.Err()
	})
	return s
}
func ptr(v bool) *bool { return &v }
func TestMCPStdioHelper(t *testing.T) {
	if os.Getenv("MODULAR_MCP_HELPER") != "1" {
		return
	}
	err := server().Run(context.Background(), &mcp.StdioTransport{})
	if err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func stdio(name string) mcptools.Server {
	return mcptools.Server{Name: name, Command: os.Args[0], Args: []string{"-test.run=^TestMCPStdioHelper$"}, Env: map[string]string{"MODULAR_MCP_HELPER": "1"}}
}
func newAgent(t *testing.T) (api.API, *mcptools.Manager) {
	t.Helper()
	h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Provider: fake.New().Plugin(), Model: "fake", Runtime: runtimetest.Plugin(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	v, _ := h.API().Get("mcp")
	return h.API(), v.(*mcptools.Manager)
}
func deadline(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	return ctx
}
func TestMCPTransportsAnnotationsResultsAndScope(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, transport := range []string{"stdio", "http-json", "http-sse"} {
			t.Run(transport, func(t *testing.T) {
				ctx := deadline(t)
				a, m := newAgent(t)
				id, err := a.New(ctx, t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				runtimetest.Publish(t, a, id)
				other, err := a.New(ctx, t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				spec := stdio("fixture")
				if transport != "stdio" {
					handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server() }, &mcp.StreamableHTTPOptions{JSONResponse: transport == "http-json"})
					httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Header.Get("X-Fixture") != "allowed" {
							w.WriteHeader(401)
							return
						}
						handler.ServeHTTP(w, r)
					}))
					defer httpServer.Close()
					spec = mcptools.Server{Name: "fixture", URL: httpServer.URL, Headers: map[string]string{"X-Fixture": "allowed"}}
				}
				if err = m.Add(ctx, id, []mcptools.Server{spec}); err != nil {
					t.Fatal(err)
				}
				defer m.Remove(id)
				snap, _ := a.Snapshot(id)
				tools := m.Tools(snap)
				if len(tools) != 4 {
					t.Fatal(tools)
				}
				byName := map[string]api.Tool{}
				for _, d := range tools {
					byName[d.Name] = d
				}
				d := byName[mcptools.Name("fixture", "echo")]
				if !d.ReadOnly || !d.SafeRepeat || d.Destructive || d.External || d.Parallel || len(d.Output) == 0 || len(d.Data) == 0 {
					t.Fatal(d)
				}
				d = byName[mcptools.Name("fixture", "effect")]
				if d.ReadOnly || !d.SafeRepeat || !d.Destructive || !d.External {
					t.Fatal(d)
				}
				d = byName[mcptools.Name("fixture", "plain")]
				if d.ReadOnly || d.SafeRepeat || !d.Destructive || !d.External {
					t.Fatal(d)
				}
				stranger, _ := a.Snapshot(other)
				if len(m.Tools(stranger)) != 0 {
					t.Fatal("session MCP tools leaked")
				}
				result, err := a.CallTool(ctx, id, api.Call{Name: mcptools.Name("fixture", "echo"), Input: api.JSON(map[string]string{"value": "cobalt"})})
				if err != nil || result.Status != "completed" || result.Content.Text() != "cobalt" || len(result.Content) != 2 || len(result.Data) == 0 {
					t.Fatal(result, err)
				}
				value := api.Decode[map[string]any](result.Structured)
				if value["value"] != "cobalt" {
					t.Fatal(value)
				}
				result, err = a.CallTool(ctx, id, api.Call{Name: mcptools.Name("fixture", "effect"), Input: api.JSON(map[string]any{})})
				if err != nil || result.Status != "failed" || !strings.Contains(result.Content.Text(), "intentional") {
					t.Fatal(result, err)
				}
				if err = a.CloseSession(id); err != nil {
					t.Fatal(err)
				}
				if len(m.Tools(snap)) != 0 {
					t.Fatal("closed session retained MCP tools")
				}
				if transport == "stdio" {
					pid := int(value["pid"].(float64))
					if err = syscall.Kill(pid, 0); err == nil {
						t.Fatal("stdio MCP process survived session close", pid)
					}
				}
			})
		}
	})
}
func TestConfiguredMCPServersServeEverySession(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		global := filepath.Join(t.TempDir(), "settings.json")
		body := api.JSON(map[string]any{"plugins": []any{map[string]any{"name": "mcp", "options": map[string]any{"servers": []mcptools.Server{stdio("shared")}}}}})
		if err := os.WriteFile(global, body, 0600); err != nil {
			t.Fatal(err)
		}
		p := fake.New(fake.Script{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "echo", Name: mcptools.Name("shared", "echo"), Input: api.JSON(map[string]string{"value": "shared-value"})}}}, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("done"), Stop: "finished"}})
		h, err := vanilla.New(vanilla.Options{History: t.TempDir(), Global: global, Project: root, Provider: p.Plugin(), Model: "fake", Runtime: runtimetest.Plugin(t)})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a := h.API()
		v, _ := a.Get("mcp")
		m := v.(*mcptools.Manager)
		id, _ := a.New(deadline(t), root)
		other, _ := a.New(deadline(t), root)
		for _, id := range []string{id, other} {
			snap, _ := a.Snapshot(id)
			if len(m.Tools(snap)) != 4 {
				t.Fatal("configured tools missing")
			}
		}
		if _, err = a.Submit(deadline(t), id, api.Input{Content: api.Text("use MCP")}); err != nil {
			t.Fatal(err)
		}
		out, err := a.Wait(deadline(t), id)
		if err != nil || out.Status != "completed" {
			t.Fatal(out, err)
		}
		snap, _ := a.Snapshot(id)
		found := false
		for _, e := range snap.Entries {
			if e.Kind == "tool.result" {
				r := api.Decode[api.ToolResult](e.Data)
				found = r.Content.Text() == "shared-value" && len(r.Structured) > 0
			}
		}
		if !found {
			t.Fatal("fake Provider MCP turn did not record result")
		}
		a.CloseSession(id)
		snap, _ = a.Snapshot(other)
		if len(m.Tools(snap)) != 4 {
			t.Fatal("closing one session closed shared server")
		}
	})
}
func TestMCPListChangesAndCancellation(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		ctx := deadline(t)
		a, m := newAgent(t)
		id, _ := a.New(ctx, t.TempDir())
		runtimetest.Publish(t, a, id)
		s := server()
		handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, nil)
		httpServer := httptest.NewServer(handler)
		defer httpServer.Close()
		changed := make(chan struct{}, 8)
		progress := make(chan struct{}, 8)
		a.Subscribe(func(e api.Event) {
			if e.Kind == "tools.changed" {
				changed <- struct{}{}
			}
			if e.Kind == "tool.progress" && strings.Contains(api.Decode[string](e.Data), "started slow") {
				progress <- struct{}{}
			}
		})
		if err := m.Add(ctx, id, []mcptools.Server{{Name: "dynamic", URL: httpServer.URL}}); err != nil {
			t.Fatal(err)
		}
		defer m.Remove(id)
		mcp.AddTool(s, &mcp.Tool{Name: "new"}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{}, nil, nil
		})
		select {
		case <-changed:
		case <-ctx.Done():
			t.Fatal("missing list-changed")
		}
		snap, _ := a.Snapshot(id)
		if len(m.Tools(snap)) != 5 {
			t.Fatal(m.Tools(snap))
		}
		done := make(chan error, 1)
		go func() {
			r, e := a.CallTool(ctx, id, api.Call{Name: mcptools.Name("dynamic", "slow"), Input: api.JSON(map[string]any{})})
			if e == nil && r.Status != "cancelled" {
				e = fmt.Errorf("status %s", r.Status)
			}
			done <- e
		}()
		select {
		case <-progress:
		case <-ctx.Done():
			t.Fatal("slow tool not running")
		}
		if err := a.Cancel(id); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("cancel stuck")
		}
	})
}
func TestMCPFailedAttachmentDoesNotPublishOrLeaveProcess(t *testing.T) {
	a, m := newAgent(t)
	ctx := deadline(t)
	id, _ := a.New(ctx, t.TempDir())
	err := m.Add(ctx, id, []mcptools.Server{stdio("one"), {Name: "bad", Command: "/missing/modular-mcp"}})
	if err == nil {
		t.Fatal("missing command connected")
	}
	snap, _ := a.Snapshot(id)
	if len(m.Tools(snap)) != 0 {
		t.Fatal("partial group published")
	}
	if err = m.Add(ctx, id, []mcptools.Server{stdio("one")}); err != nil {
		t.Fatal("failed group not rolled back", err)
	}
	m.Remove(id)
}
