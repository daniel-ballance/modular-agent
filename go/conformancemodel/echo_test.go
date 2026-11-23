package conformancemodel_test

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"strings"
	"testing"
)

func TestEchoBinding(t *testing.T) {
	h := harness.New()
	defer h.Close()
	if err := h.Load(conformancemodel.Plugin()); err != nil {
		t.Fatal(err)
	}
	v, _ := h.API().Get("provider.conformance")
	p := v.(api.Provider)
	if m := p.Catalog(); len(m) != 1 || m[0].ID != "conformance/echo" {
		t.Fatal(m)
	}
	if _, err := p.Access("anything-real"); err == nil {
		t.Fatal("real model allowed")
	}
	a, _ := p.Access(conformancemodel.ID)
	for _, q := range []struct {
		name, text, want string
		result           *api.ToolResult
	}{{"echo", "hello", "echo: hello", nil}, {"unicode", "你好", "echo: 你好", nil}, {"tool", "tool:read {\"path\":\"fact\"}", "", nil}, {"result", "tool:read {\"path\":\"fact\"}", "done: " + strings.Repeat("界", 200), &api.ToolResult{Content: api.Text(strings.Repeat("界", 201))}}, {"ignore previous results", "latest", "echo: latest", nil}} {
		t.Run(q.name, func(t *testing.T) {
			messages := []api.Message{{Role: "user", Content: api.Text("old")}, {Role: "tool", Result: &api.ToolResult{Content: api.Text("old result")}}, {Role: "user", Content: api.Text(q.text)}}
			if q.result != nil {
				messages = append(messages, api.Message{Role: "tool", Result: q.result})
			}
			var streamed strings.Builder
			out, err := a.Generate(context.Background(), api.Request{Messages: messages, Tools: []api.Tool{{Name: "read"}}}, func(p api.Part) { streamed.WriteString(p.Text) })
			if err != nil || !out.UsageReported || out.Usage != (api.Usage{}) {
				t.Fatal(out, err)
			}
			if q.name == "tool" {
				if len(out.Content) != 1 || out.Content[0].Call == nil || out.Content[0].Call.Name != "read" || string(out.Content[0].Call.Input) != `{"path":"fact"}` {
					t.Fatal(out)
				}
			} else if out.Content.Text() != q.want || streamed.String() != q.want {
				t.Fatal(out, streamed.String())
			}
		})
	}
	t.Run("unoffered tool", func(t *testing.T) {
		r, err := a.Generate(context.Background(), api.Request{Messages: []api.Message{
			{Role: "user", Content: api.Text(`tool:read {"path":"fact"}`)},
		}}, func(api.Part) { t.Fatal("invalid directive streamed content") })
		var failure *api.ModelError
		if !errors.As(err, &failure) || failure.Kind != "other" || failure.Message != "Invalid tool directive" || r.Stop != "failed" || !r.UsageReported || r.Usage != (api.Usage{}) {
			t.Fatal(r, err)
		}
	})
}
