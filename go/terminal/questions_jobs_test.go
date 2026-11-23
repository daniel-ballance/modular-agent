package terminal_test

import (
	"bytes"
	"context"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/credentials"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/terminal"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLineInterfaceAnswersSecretsWithoutSubmittingTheirValue(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		secret := filepath.Join(root, "secret")
		_ = os.WriteFile(secret, []byte("private-line-secret"), 0600)
		p := fake.New(fake.Script{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "secret", Name: "ask_user", Input: api.JSON(map[string]string{"kind": "secret", "question": "Token?", "credential": "deploy"})}}}, Stop: "tools"}}, fake.Script{Require: "deploy", Response: api.Response{Content: api.Text("stored"), Stop: "finished"}})
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		if err = h.Load(credentials.Plugin(filepath.Join(root, "key"))); err != nil {
			t.Fatal(err)
		}
		input, writer := io.Pipe()
		defer writer.Close()
		h.API().Subscribe(func(e api.Event) {
			if e.Kind == "question.open" {
				q := api.Decode[api.Question](e.Data)
				_, _ = fmt.Fprintf(writer, "/secret %s %s\n", q.ID, secret)
			}
		})
		v, _ := h.API().Get("interface.terminal")
		var stdout, stderr bytes.Buffer
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.API().Subscribe(func(e api.Event) {
			if e.Kind == "turn.end" {
				go func() { _, _ = io.WriteString(writer, "/quit\n") }()
			}
		})
		err = v.(*terminal.Terminal).Run(ctx, terminal.Options{Project: root, Mode: "line", Prompt: "go"}, input, &stdout, &stderr)
		if err != nil {
			t.Fatal(err)
		}
		list, _ := h.API().List("")
		if strings.Contains(stdout.String()+stderr.String()+string(api.JSON(list))+string(api.JSON(p.Requests())), "private-line-secret") {
			t.Fatal("terminal leaked secret")
		}
		if !strings.Contains(stdout.String(), "stored") || len(p.Requests()) != 2 {
			t.Fatal(stdout.String(), stderr.String())
		}
	})
}
func TestPrintWaitsForBackgroundJobAndItsParentTurn(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		release := make(chan struct{})
		var once sync.Once
		var scripts []fake.Script
		run := func(ctx context.Context, r api.Request, _ func(api.Part)) (api.Response, error) {
			first := ""
			models := 0
			reported := false
			for _, m := range r.Messages {
				if m.Role == "user" && first == "" {
					first = m.Content.Text()
				}
				if m.Role == "assistant" {
					models++
				}
				if m.Role == "user" && m.Content.Text() == "child finished" {
					reported = true
				}
			}
			if first == "child-only" {
				select {
				case <-release:
				case <-ctx.Done():
					return api.Response{}, ctx.Err()
				}
				return api.Response{Content: api.Text("child finished"), Stop: "finished"}, nil
			}
			if models == 0 {
				return api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "delegate", Name: "delegate", Input: api.JSON(map[string]any{"task": "child-only", "background": true})}}}, Stop: "tools"}, nil
			}
			answer := "started"
			if reported {
				answer = "reported child"
			}
			return api.Response{Content: api.Text(answer), Stop: "finished"}, nil
		}
		for range 8 {
			scripts = append(scripts, fake.Script{Run: run})
		}
		p := fake.New(scripts...)
		root := t.TempDir()
		h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Global: filepath.Join(root, "absent"), Runtime: runtimetest.Plugin(t), Provider: p.Plugin(), Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		h.API().Subscribe(func(e api.Event) {
			if e.Kind == "turn.end" && api.Decode[api.Outcome](e.Data).Result.Text() == "started" {
				once.Do(func() { close(release) })
			}
		})
		v, _ := h.API().Get("interface.terminal")
		var stdout, stderr bytes.Buffer
		// The fixture releases the child when the first parent turn ends. Wait
		// for print mode to return; elapsed time is not part of this contract.
		err = v.(*terminal.Terminal).Run(t.Context(), terminal.Options{Project: t.TempDir(), Mode: "print", Prompt: "parent-only", WaitJobs: true}, io.NopCloser(strings.NewReader("")), &stdout, &stderr)
		if err != nil || stdout.String() != "reported child\n" {
			t.Fatal(stdout.String(), stderr.String(), err)
		}
	})
}
