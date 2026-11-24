package subscription

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

func TestReplayOpaqueOutputOnlyForItsProvider(t *testing.T) {
	c := responsesConfig{id: "chatgpt"}
	for _, id := range []string{"chatgpt", "openai-codex", "grok", ""} {
		data, _ := json.Marshal(map[string]any{"provider": id, "output": []map[string]string{{"type": "reasoning", "encrypted_content": "fixture-envelope"}}})
		body := c.requestBody(subscriptionModel{}, modular.ModelRequest{Messages: []modular.Message{{Role: "assistant", Content: modular.Text("portable"), ProviderData: data}}})
		input, err := json.Marshal(body["input"])
		if err != nil || bytes.Contains(input, []byte("fixture-envelope")) != (id == c.id) || bytes.Contains(input, []byte("portable")) == (id == c.id) {
			t.Fatalf("wrong replay for %q", id)
		}
	}
}
