package questions_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestExternalSIGKILLQuestion(t *testing.T) {
	if root := os.Getenv("M3_UI_ROOT"); root != "" {
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Provider: fake.New().Plugin(), Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		id, _ := h.API().New(context.Background(), root)
		_ = os.WriteFile(filepath.Join(root, "session"), []byte(id), 0600)
		h.API().Subscribe(func(e api.Event) {
			if e.Kind == "question.open" {
				_ = os.WriteFile(filepath.Join(root, "ready"), []byte("yes"), 0600)
				for {
					time.Sleep(time.Hour)
				}
			}
		})
		_, _ = h.API().CallTool(context.Background(), id, api.Call{Name: "ask_user", Input: api.JSON(map[string]string{"question": "UI color?"})})
		t.Fatal("question did not open")
	}
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		cmd := exec.Command(os.Args[0], "-test.run=^TestExternalSIGKILLQuestion$")
		cmd.Env = append(os.Environ(), "M3_UI_ROOT="+root)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if cmd.ProcessState == nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
			}
		})
		deadline := time.Now().Add(5 * time.Second)
		for {
			if _, err := os.Stat(filepath.Join(root, "ready")); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("UI question never opened")
			}
			time.Sleep(time.Millisecond * 5)
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		b, _ := os.ReadFile(filepath.Join(root, "session"))
		id := string(b)
		p := fake.New()
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		a := h.API()
		v, _ := a.Get("questions")
		q := v.(api.Questions)
		asked := 0
		a.Subscribe(func(e api.Event) {
			if e.Kind == "question.open" {
				asked++
				question := api.Decode[api.Question](e.Data)
				if err := q.Answer(context.Background(), id, api.Answer{Request: question.ID, Value: "cobalt"}); err != nil {
					t.Error(err)
				}
			}
		})
		if err = a.Open(context.Background(), id); err != nil {
			t.Fatal(err)
		}
		_ = wait(t, a, id)
		s, _ := a.Snapshot(id)
		results := 0
		for _, e := range s.Entries {
			if e.Kind == "tool.result" {
				results++
				r := api.Decode[api.ToolResult](e.Data)
				if runtimetest.Plugin(t).Name == "durable" {
					if r.Status != "completed" || r.Content.Text() != "cobalt" || asked != 1 {
						t.Fatal(r, asked)
					}
				} else if r.Status != "unknown" || asked != 0 {
					t.Fatal(r, asked)
				}
			}
		}
		if results != 1 || len(p.Requests()) != 0 {
			t.Fatal(results, "external recovery invoked model")
		}
	})
}
