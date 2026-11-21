package modular_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/internal/apikeymodels"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/anthropic"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/openai"
)

func TestAPIKeyReasoningMappings(t *testing.T) {
	type fixture struct {
		provider, id, level string
		limit               int
		want                map[string]json.RawMessage
	}
	var cases []fixture
	for _, vendor := range []string{"openai", "anthropic"} {
		for _, m := range apikeymodels.Catalog(vendor) {
			cases = append(cases, fixture{vendor, m.ID, "", 10000, nil})
			for level, fields := range m.Levels {
				cases = append(cases, fixture{vendor, m.ID, level, 10000, fields})
			}
		}
		cases = append(cases, fixture{vendor, "explicit-alias", "high", 2048, nil})
	}
	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	cases = append(cases,
		fixture{"openai", "gpt-5", "off", 2048, nil},
		fixture{"openai", "gpt-6-luna", "minimal", 2048, map[string]json.RawMessage{"reasoning": raw(`{"effort":"none"}`)}},
		fixture{"anthropic", "claude-opus-5-5", "off", 2048, nil},
		fixture{"anthropic", "claude-opus-4-5", "high", 2048, map[string]json.RawMessage{"thinking": raw(`{"type":"enabled","budget_tokens":2047}`), "output_config": raw(`{"effort":"high"}`)}},
		fixture{"anthropic", "claude-opus-4-5", "high", 1024, map[string]json.RawMessage{"thinking": raw(`{"type":"disabled"}`)}},
	)
	for _, fc := range cases {
		t.Run(fmt.Sprintf("%s/%s/%s/%d", fc.provider, fc.id, fc.level, fc.limit), func(t *testing.T) {
			t.Setenv("OPENAI_API_KEY", "offline-fixture")
			t.Setenv("ANTHROPIC_API_KEY", "offline-fixture")
			bodies := make(chan map[string]json.RawMessage, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				bodies <- body
				if fc.provider == "openai" {
					fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{}}\n\n")
				} else {
					fmt.Fprint(w, "data: {\"type\":\"message_start\",\"message\":{}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n")
				}
			}))
			defer server.Close()
			custom := modular.ModelInfo{ModelRef: modular.ModelRef{ID: "explicit-alias"}, MaxOutput: 8192, ContextWindow: 32768, Input: []string{"text", "image"}, Thinking: []string{"high"}}
			var p modular.Provider
			if fc.provider == "openai" {
				p = openai.New(openai.WithEndpoint(server.URL), openai.WithModels(custom))
			} else {
				p = anthropic.New(anthropic.WithEndpoint(server.URL), anthropic.WithModels(custom))
			}
			a := modulartest.Agent(t, modular.WithProvider(p), modular.WithModel(fc.provider+"/"+fc.id), modular.WithSettings(modular.Settings{"reasoning": fc.level, "maxOutput": fc.limit}))
			for _, m := range a.Models() {
				if m.ID != fc.id {
					continue
				}
				if table, ok := apikeymodels.Lookup(fc.provider, m.ID); ok {
					if !reflect.DeepEqual(m.Thinking, table.Thinking()) || !reflect.DeepEqual(m.Input, table.Input) || m.MaxOutput != table.MaxOutput {
						t.Fatalf("catalog entry %+v", m)
					}
				} else if len(m.Thinking) != 0 || m.MaxOutput != 8192 || m.ContextWindow != 32768 {
					t.Fatalf("enrolled entry %+v", m)
				}
			}
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			result, err := s.Prompt(t.Context(), "Hello")
			if err != nil || result.Outcome == nil || result.Outcome.Kind != "completed" {
				t.Fatalf("prompt: %+v, %v", result.Outcome, err)
			}
			select {
			case body := <-bodies:
				for _, key := range []string{"reasoning", "thinking", "output_config"} {
					var got, want any
					_ = json.Unmarshal(body[key], &got)
					_ = json.Unmarshal(fc.want[key], &want)
					if !reflect.DeepEqual(got, want) {
						t.Errorf("%s: got %s, want %s", key, body[key], fc.want[key])
					}
				}
			default:
				t.Fatal("no request reached loopback")
			}
		})
	}
}
