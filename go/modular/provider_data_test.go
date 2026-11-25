package modular_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

func TestProviderDataBoundToProducingProvider(t *testing.T) {
	const opaque = "opaque-fixture-value"
	modelSeen := map[string][]bool{}
	provider := func(id string) modular.Provider {
		return modular.Provider{ID: id, Models: func() []modular.ModelInfo {
			return []modular.ModelInfo{{ModelRef: modular.ModelRef{Provider: id, ID: "model"}, ContextWindow: 64000, MaxOutput: 1024}}
		}, Request: func(_ context.Context, _ modular.ModelRef, request modular.ModelRequest, _ *modular.ProviderContext) (modular.AssistantMessage, error) {
			raw, _ := json.Marshal(request)
			modelSeen[id] = append(modelSeen[id], strings.Contains(string(raw), opaque))
			return modular.AssistantMessage{Stop: "finished", ProviderData: []byte(`"` + opaque + `"`), Content: append(modular.Text("answer"), modular.Part{Type: "reasoning", Text: "readable", Fields: map[string]json.RawMessage{"providerData": []byte(`"` + opaque + `"`)}})}, nil
		}}
	}
	a, err := modular.New(t.Context(),
		modular.WithProject(gitProject(t)),
		modular.WithModel("first/model"),
		modular.WithProvider(provider("first")),
		modular.WithProvider(provider("second")),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	prompt := func() {
		r, err := s.Prompt(t.Context(), "question")
		if err != nil || r.Outcome == nil || r.Outcome.Kind != "completed" {
			t.Fatalf("prompt: %+v: %v", r, err)
		}
	}
	prompt()
	prompt()
	if err := s.SetSetting(t.Context(), "model", "second/model"); err != nil {
		t.Fatal(err)
	}
	prompt()
	if got := modelSeen["first"]; len(got) != 2 || got[0] || !got[1] {
		t.Fatalf("originating Provider: %v", got)
	}
	if got := modelSeen["second"]; len(got) != 1 || got[0] {
		t.Fatalf("other Provider: %v", got)
	}
	history, err := s.History(t.Context())
	raw, _ := json.Marshal(history)
	if err != nil || strings.Contains(string(raw), opaque) || !strings.Contains(string(raw), "readable") {
		for _, entry := range history {
			b, _ := json.Marshal(entry)
			if strings.Contains(string(b), opaque) || strings.Contains(string(b), "readable") {
				t.Logf("entry: %s", b)
			}
		}
		t.Fatalf("history exposed opaque data or dropped readable reasoning: %v", err)
	}
}
