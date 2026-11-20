// Package openai provides the OpenAI Responses API Provider.
package openai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

const defaultEndpoint = "https://api.openai.com/v1/responses"
const defaultModel = "gpt-6-luna"

type Option func(*options)
type options struct {
	endpoint string
	client   *http.Client
	model    string
}

func WithEndpoint(url string) Option            { return func(o *options) { o.endpoint = url } }
func WithHTTPClient(client *http.Client) Option { return func(o *options) { o.client = client } }
func WithModel(id string) Option                { return func(o *options) { o.model = id } }
func New(opts ...Option) modular.Provider {
	o := options{endpoint: defaultEndpoint, model: defaultModel, client: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Provider redirects refused") }}}
	for _, opt := range opts {
		opt(&o)
	}
	return modular.Provider{
		ID: "openai",
		Models: func() []modular.ModelInfo {
			return []modular.ModelInfo{{ModelRef: modular.ModelRef{Provider: "openai", ID: o.model}, ContextWindow: 128000, MaxOutput: 16000, Input: []string{"text"}, Reasoning: true, Thinking: []string{"off", "low", "medium", "high"}}}
		},
		Request: o.request,
	}
}
func (o options) request(ctx context.Context, model modular.ModelRef, request modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
	key, err := pc.Credential()
	if err != nil {
		return modelFailure(modular.Credentials, "OpenAI credential unavailable")
	}
	input := make([]any, 0, len(request.Messages))
	for _, m := range request.Messages {
		switch m.Role {
		case "toolResult":
			input = append(input, map[string]any{"type": "function_call_output", "call_id": m.ToolCallID, "output": m.Content.Text()})
		case "assistant", "user":
			if text := m.Content.Text(); text != "" {
				input = append(input, map[string]any{"role": m.Role, "content": text})
			}
			for _, p := range m.Content {
				if p.Type == "toolCall" {
					input = append(input, map[string]any{"type": "function_call", "call_id": p.Fields["id"], "name": p.Fields["name"], "arguments": string(p.Fields["arguments"])})
				}
			}
		}
	}
	payload := map[string]any{"model": model.ID, "input": input, "stream": true, "store": false}
	if effort, ok := request.Settings["reasoning"].(string); ok && effort != "" && effort != "off" {
		payload["reasoning"] = map[string]any{"effort": effort}
	}
	if request.SystemPrompt != "" {
		payload["instructions"] = request.SystemPrompt
	}
	if n := request.Settings["maxOutput"]; n != nil {
		payload["max_output_tokens"] = n
	}
	if len(request.Tools) > 0 {
		tools := make([]any, 0, len(request.Tools))
		for _, t := range request.Tools {
			tools = append(tools, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": t.Parameters, "strict": false})
		}
		payload["tools"] = tools
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return modular.AssistantMessage{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.endpoint, bytes.NewReader(b))
	if err != nil {
		return modular.AssistantMessage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	res, err := o.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return modular.AssistantMessage{}, ctx.Err()
		}
		return modelFailure(modular.Temporary, "OpenAI transport failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		var body struct{ Error wireError }
		_ = json.NewDecoder(http.MaxBytesReader(nil, res.Body, 1<<20)).Decode(&body)
		return modelFailure(classify(body.Error.Code, res.StatusCode), "OpenAI request failed: "+http.StatusText(res.StatusCode))
	}
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	for scanner.Scan() {
		data, ok := strings.CutPrefix(scanner.Text(), "data:")
		if !ok {
			continue
		}
		data = strings.TrimSpace(data)
		if data == "[DONE]" {
			break
		}
		var event struct {
			Type, Delta, Code string
			Response          response
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return modelFailure(modular.Other, "invalid OpenAI event")
		}
		switch event.Type {
		case "response.output_text.delta":
			pc.Piece("text", event.Delta)
		case "response.reasoning_summary_text.delta":
			pc.Piece("reasoning", event.Delta)
		case "response.completed", "response.incomplete":
			return event.Response.assistant()
		case "response.failed", "error":
			code := event.Code
			if code == "" {
				code = event.Response.Error.Code
			}
			return modelFailure(classify(code, 0), "OpenAI response failed")
		}
	}
	if ctx.Err() != nil {
		return modular.AssistantMessage{}, ctx.Err()
	}
	return modelFailure(modular.Temporary, "OpenAI stream ended before the final response")
}

type wireError struct{ Code string }
type response struct {
	Error      wireError
	Incomplete struct{ Reason string } `json:"incomplete_details"`
	Output     []struct {
		Type, Name, Arguments string
		CallID                string `json:"call_id"`
		Content               []struct{ Type, Text, Refusal string }
	}
	Usage struct {
		Input   int `json:"input_tokens"`
		Output  int `json:"output_tokens"`
		Details struct {
			Cached int `json:"cached_tokens"`
		} `json:"input_tokens_details"`
	}
}

func (r response) assistant() (modular.AssistantMessage, error) {
	out := modular.AssistantMessage{Role: "assistant", Stop: "finished", Usage: modular.Usage{Input: r.Usage.Input, Output: r.Usage.Output, CacheRead: r.Usage.Details.Cached}}
	for _, item := range r.Output {
		switch item.Type {
		case "message":
			for _, p := range item.Content {
				switch p.Type {
				case "output_text":
					out.Content = append(out.Content, modular.Text(p.Text)...)
				case "refusal":
					out.Content = append(out.Content, modular.Text(p.Refusal)...)
					out.Stop = "refused"
				}
			}
		case "function_call":
			id, _ := json.Marshal(item.CallID)
			name, _ := json.Marshal(item.Name)
			if item.CallID == "" || item.Name == "" || !json.Valid([]byte(item.Arguments)) {
				return modelFailure(modular.Other, "invalid OpenAI tool call")
			}
			out.Content = append(out.Content, modular.Part{Type: "toolCall", Fields: map[string]json.RawMessage{"id": id, "name": name, "arguments": json.RawMessage(item.Arguments)}})
			out.Stop = "toolUse"
		}
	}
	switch r.Incomplete.Reason {
	case "max_output_tokens":
		out.Stop = "length"
	case "content_filter":
		return modelFailure(modular.ModelRefused, "OpenAI content filter refused the response")
	}
	return out, nil
}
func modelFailure(kind modular.ModelErrorKind, message string) (modular.AssistantMessage, error) {
	return modular.AssistantMessage{}, &modular.ModelError{Kind: kind, Message: message}
}
func classify(code string, status int) modular.ModelErrorKind {
	switch code {
	case "context_length_exceeded":
		return modular.ContextTooLarge
	case "invalid_api_key":
		return modular.Credentials
	case "content_filter":
		return modular.ModelRefused
	case "rate_limit_exceeded", "server_error":
		return modular.Temporary
	}
	switch {
	case status == 401 || status == 403:
		return modular.Credentials
	case status == 429 || status >= 500:
		return modular.Temporary
	default:
		return modular.Other
	}
}
