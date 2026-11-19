package acpinterface_test

import (
	"context"
	"encoding/json"
	"github.com/OWNER/modular-agent/go/acpinterface"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func bindingMeta(p acp.PromptResponse) map[string]any {
	return api.Decode[map[string]any](p.Meta[acpinterface.Namespace])
}
func TestACPBindingStopReasons(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, q := range []struct{ name, stop, want, kind string }{{"completed", "finished", "end_turn", "completed"}, {"failed", "refused", "refusal", "failed"}, {"output", "output_limit", "max_tokens", "limit"}, {"steps", "continue", "max_turn_requests", "limit"}} {
			t.Run(q.name, func(t *testing.T) {
				root := t.TempDir()
				response := api.Response{Content: api.Text("result"), Stop: q.stop}
				if q.name == "steps" {
					response.Content = api.Content{call("read", "read", map[string]string{"path": "missing"})}
					response.Stop = "tools"
				}
				p := fake.New(fake.Script{Response: response})
				a := compose(t, root, p)
				conn, _ := connection(t, a, &client{})
				initClient(t, conn, false)
				s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
				if err != nil {
					t.Fatal(err)
				}
				snap, _ := a.Snapshot(string(s.SessionId))
				snap.Settings.MaxSteps = 1
				if err = a.SetSettings(timeout(t), snap.ID, snap.Settings); err != nil {
					t.Fatal(err)
				}
				out := prompt(t, conn, s.SessionId, "test", "once")
				m := bindingMeta(out)
				if string(out.StopReason) != q.want || m["outcome"].(map[string]any)["kind"] != q.kind {
					t.Fatal(out, string(api.JSON(m)))
				}
				if m["inputId"] == "" || m["openToolCalls"] != nil {
					t.Fatal(m)
				}
				if q.kind == "failed" && m["outcome"].(map[string]any)["error"] == nil {
					t.Fatal("missing failure", m)
				}
				if q.kind == "limit" {
					if m["outcome"].(map[string]any)["limit"] != q.name {
						t.Fatal(m)
					}
				}
			})
		}
	})
}
func TestACPBindingQuestionsWithoutFormsAndPastTurn(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		for _, late := range []bool{false, true} {
			t.Run(map[bool]string{false: "waiting", true: "late"}[late], func(t *testing.T) {
				root := t.TempDir()
				wait := 5000
				if late {
					wait = 1
				}
				p := fake.New(fake.Script{Response: api.Response{Content: api.Content{call("ask", "ask_user", map[string]any{"question": "Color?", "kind": "choice", "options": []string{"cobalt"}, "wait_ms": wait})}, Stop: "tools"}}, fake.Script{Require: "cobalt", Response: api.Response{Content: api.Text("answered"), Stop: "finished"}})
				a := compose(t, root, p)
				c := &client{}
				conn, _ := connection(t, a, c)
				initClient(t, conn, false)
				s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
				if err != nil {
					t.Fatal(err)
				}
				type result struct {
					out acp.PromptResponse
					err error
				}
				done := make(chan result, 1)
				go func() {
					out, err := conn.Prompt(timeout(t), acp.PromptRequest{SessionId: s.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("ask")}})
					done <- result{out, err}
				}()
				if late {
					r := <-done
					if r.err != nil || r.out.StopReason != acp.StopReasonEndTurn || len(bindingMeta(r.out)["openToolCalls"].([]any)) != 1 {
						t.Fatal(r)
					}
					if !strings.Contains(c.text(), `"status":"pending"`) {
						t.Fatal("open call not pending", c.text())
					}
				}
				var requests []struct {
					ID, Kind, Question string
					Answerable         bool
				}
				deadline := time.Now().Add(3 * time.Second)
				for len(requests) == 0 && time.Now().Before(deadline) {
					raw, err := conn.CallExtension(timeout(t), "_modular-agent/requests", map[string]any{"sessionId": s.SessionId})
					if err != nil {
						t.Fatal(err)
					}
					var q struct {
						Requests []struct {
							ID, Kind, Question string
							Answerable         bool
						}
					}
					json.Unmarshal(raw, &q)
					requests = q.Requests
					if len(requests) == 0 {
						time.Sleep(time.Millisecond)
					}
				}
				if len(requests) != 1 || requests[0].Kind != "choice" || !requests[0].Answerable || requests[0].Question != "Color?" {
					t.Fatal(requests)
				}
				raw, err := conn.CallExtension(timeout(t), "_modular-agent/answer", map[string]any{"sessionId": s.SessionId, "requestId": requests[0].ID, "value": "cobalt", "actor": "forged"})
				if err != nil || !api.Decode[struct{ Accepted bool }](raw).Accepted {
					t.Fatal(string(raw), err)
				}
				if !late {
					r := <-done
					if r.err != nil || r.out.StopReason != acp.StopReasonEndTurn {
						t.Fatal(r)
					}
				} else {
					if _, err = a.Wait(timeout(t), string(s.SessionId)); err != nil {
						t.Fatal(err)
					}
				}
				snap, _ := a.Snapshot(string(s.SessionId))
				if strings.Contains(string(api.JSON(snap)), "forged") {
					t.Fatal("forged answer actor")
				}
			})
		}
	})
}
func TestACPBindingCancelledHandedBackAndDuplicate(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		started := make(chan struct{})
		p := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			close(started)
			<-ctx.Done()
			return api.Response{}, ctx.Err()
		}})
		a := compose(t, root, p)
		conn, _ := connection(t, a, &client{})
		initClient(t, conn, false)
		s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan acp.PromptResponse, 1)
		go func() {
			out, err := conn.Prompt(timeout(t), acp.PromptRequest{SessionId: s.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("block")}, Meta: map[string]json.RawMessage{acpinterface.Namespace: api.JSON(map[string]string{"key": "block"})}})
			if err != nil {
				t.Error(err)
			}
			done <- out
		}()
		<-started
		raw, err := conn.CallExtension(timeout(t), "_modular-agent/input", map[string]any{"sessionId": s.SessionId, "when": "after", "content": []any{map[string]string{"type": "text", "text": "not taken"}}, "key": "queued"})
		if err != nil {
			t.Fatal(err)
		}
		receipt := api.Decode[map[string]any](raw)
		if err = conn.Cancel(timeout(t), acp.CancelNotification{SessionId: s.SessionId}); err != nil {
			t.Fatal(err)
		}
		first := <-done
		for _, out := range []acp.PromptResponse{first, prompt(t, conn, s.SessionId, "resend", "block")} {
			m := bindingMeta(out)
			returned := m["handedBack"].([]any)
			if out.StopReason != acp.StopReasonCancelled || len(returned) != 1 || returned[0].(map[string]any)["inputId"] != receipt["inputId"] || !strings.Contains(string(api.JSON(returned)), "not taken") {
				t.Fatal(out, m)
			}
		}
	})
}
func TestACPApprovalChangesApplyNextTurn(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		started, release := make(chan struct{}), make(chan struct{})
		p := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return api.Response{}, ctx.Err()
			}
			return api.Response{Content: api.Content{call("first", "write", map[string]string{"path": "first", "content": "yes"})}, Stop: "tools"}, nil
		}}, fake.Script{Response: api.Response{Content: api.Text("first done"), Stop: "finished"}}, fake.Script{Response: api.Response{Content: api.Content{call("second", "write", map[string]string{"path": "second", "content": "no"})}, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("second done"), Stop: "finished"}})
		a := compose(t, root, p)
		conn, _ := connection(t, a, &client{})
		initClient(t, conn, false)
		s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			_, err := conn.Prompt(timeout(t), acp.PromptRequest{SessionId: s.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("first")}})
			done <- err
		}()
		<-started
		if _, err = conn.SetSessionConfigOption(timeout(t), acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{SessionId: s.SessionId, ConfigId: "approval", Value: "never"}}); err != nil {
			t.Fatal(err)
		}
		close(release)
		if err = <-done; err != nil {
			t.Fatal(err)
		}
		prompt(t, conn, s.SessionId, "second", "")
		if _, err = os.Stat(filepath.Join(root, "first")); err != nil {
			t.Fatal("new policy changed running turn", err)
		}
		if _, err = os.Stat(filepath.Join(root, "second")); !os.IsNotExist(err) {
			t.Fatal("next-turn policy ignored", err)
		}
	})
}
