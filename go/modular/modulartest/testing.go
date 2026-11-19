// Package modulartest builds agents for offline tests.
package modulartest

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"github.com/OWNER/modular-agent/go/modular"
)

const ScriptedModel = "scripted/script"

type Reply struct {
	Text      string `json:"text,omitempty"`
	Reasoning string `json:"reasoning,omitempty"`
	ToolCalls []struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	} `json:"toolCalls,omitempty"`
	Error *modular.ModelError `json:"error,omitempty"`
	Usage modular.Usage       `json:"usage,omitempty"`
}

func ScriptedProvider(script []Reply) modular.Provider {
	return modular.Provider{
		ID: "scripted",
		Models: func() []modular.ModelInfo {
			return []modular.ModelInfo{{ModelRef: modular.ModelRef{Provider: "scripted", ID: "script"}, ContextWindow: 100000, MaxOutput: 16000, Input: []string{"text"}}}
		},
		Supports: modular.ProviderSupport{SafeToRepeat: true},
		Request: func(ctx context.Context, _ modular.ModelRef, r modular.ModelRequest, p *modular.ProviderContext) (modular.AssistantMessage, error) {
			if err := ctx.Err(); err != nil {
				return modular.AssistantMessage{}, err
			}
			index := 0
			for _, m := range r.Messages {
				if m.Role == "assistant" {
					index++
				}
			}
			if index >= len(script) {
				return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Other, Message: "script exhausted"}
			}
			reply := script[index]
			if reply.Error != nil {
				return modular.AssistantMessage{}, reply.Error
			}
			res := modular.AssistantMessage{Stop: "finished", Usage: reply.Usage}
			if reply.Reasoning != "" {
				p.Piece("reasoning", reply.Reasoning)
				res.Content = append(res.Content, modular.Part{Type: "reasoning", Text: reply.Reasoning})
			}
			if reply.Text != "" {
				p.Piece("text", reply.Text)
				res.Content = append(res.Content, modular.Text(reply.Text)...)
			}
			for i, c := range reply.ToolCalls {
				id, _ := json.Marshal(fmt.Sprintf("script-%d-%d", index, i))
				name, _ := json.Marshal(c.Name)
				res.Content = append(res.Content, modular.Part{Type: "toolCall", Fields: map[string]json.RawMessage{"id": id, "name": name, "arguments": c.Input}})
				res.Stop = "toolUse"
			}
			return res, nil
		},
	}
}

func Script(text string) modular.Option {
	var replies []Reply
	if err := json.Unmarshal([]byte(text), &replies); err != nil || replies == nil {
		// A malformed script must fail composition instead of looking exhausted.
		return modular.WithProvider(modular.Provider{ID: "scripted"})
	}
	return modular.WithProvider(ScriptedProvider(replies))
}

func Agent(t testing.TB, opts ...modular.Option) *modular.Agent {
	t.Helper()
	opts = append([]modular.Option{modular.WithProject(t.TempDir())}, opts...)
	a, err := modular.New(t.Context(), opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := a.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return a
}

// OverWire selects the same plugin, loaded over the plugin RPC binding.
func OverWire(plugin modular.Plugin) modular.Option { return modular.WithWirePlugin(plugin) }

// Restart simulates process interruption and rebuilds the agent over its store.
func Restart(t testing.TB, agent *modular.Agent) *modular.Agent {
	t.Helper()
	fresh, err := agent.RestartForTest(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := fresh.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return fresh
}

func Answers(list ...modular.Answer) modular.QuestionHandler {
	var mu sync.Mutex
	i := 0
	return func(_ context.Context, _ modular.Question) (modular.Answer, error) {
		mu.Lock()
		defer mu.Unlock()
		if i >= len(list) {
			return modular.Answer{}, fmt.Errorf("the test expected no more questions")
		}
		a := list[i]
		i++
		return a, nil
	}
}
