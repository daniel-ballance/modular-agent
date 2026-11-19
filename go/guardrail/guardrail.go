// Package guardrail redacts recipient views, leaving the record untouched.
package guardrail

import (
	"bytes"
	"context"
	"encoding/json"
	"modular/api"
	"sort"
	"strings"
	"sync"
)

func Plugin(secrets []string) api.Plugin {
	var mu sync.Mutex
	held := map[string]string{}
	secrets = append([]string(nil), secrets...)
	sort.SliceStable(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	return api.Plugin{Name: "guardrail", Setup: func(a api.API) error {
		if err := a.Provide("output-policy", len(secrets) > 0); err != nil {
			return err
		}
		return a.Handle("output", "last", func(ctx context.Context, v any) (api.Decision, error) {
			out := v.(api.Output)
			e := out.Event
			key := e.Session + ":" + e.Turn + ":" + e.Step
			mu.Lock()
			defer mu.Unlock()
			if len(secrets) > 0 {
				switch e.Kind {
				case "model.delta":
					p := api.Decode[api.Part](e.Data)
					if p.Text != "" {
						held[key] += p.Text
						out.Hold = true
						return api.Decision{Value: out}, nil
					}
				case "model.stream.end":
					if api.Decode[string](e.Data) == "failed" {
						delete(held, key)
						break
					}
					if s, ok := held[key]; ok {
						delete(held, key)
						e.Kind = "model.delta"
						e.Data = api.JSON(api.Part{Type: "text", Text: s})
					}
				case "turn.end":
					for stream := range held {
						if strings.HasPrefix(stream, e.Session+":"+e.Turn+":") {
							delete(held, stream)
						}
					}
				case "tool.progress":
					// Complete tool.end and history entries carry the whole result.
					out.Hold = true
					return api.Decision{Value: out}, nil
				}
			}
			var value any
			decoder := json.NewDecoder(bytes.NewReader(api.JSON(e)))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil {
				return api.Decision{}, err
			}
			// Decode into a fresh event: RawMessage reuses its backing array
			// when unmarshalled into a shallow copy of a recorded event.
			e = api.Event{Method: e.Method}
			if err := json.Unmarshal(api.JSON(redact(value, secrets)), &e); err != nil {
				return api.Decision{}, err
			}
			out.Event = e
			return api.Decision{Value: out}, nil
		})
	}}
}
func redact(v any, secrets []string) any {
	switch value := v.(type) {
	case string:
		for _, secret := range secrets {
			if secret != "" {
				value = strings.ReplaceAll(value, secret, "[REDACTED]")
			}
		}
		return value
	case []any:
		for i, item := range value {
			value[i] = redact(item, secrets)
		}
	case map[string]any:
		redacted := map[string]any{}
		for key, item := range value {
			redacted[redact(key, secrets).(string)] = redact(item, secrets)
		}
		return redacted
	}
	return v
}
