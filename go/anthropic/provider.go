// Package anthropic adapts the Messages API. Only claude-haiku-5-5 is offered.
// Sources checked for this build:
// https://platform.claude.com/docs/en/api/overview
// https://platform.claude.com/docs/en/api/messages
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
// https://platform.claude.com/docs/en/build-with-claude/thinking
package anthropic

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"modular/api"
	"net/http"
	"sort"
	"strings"
	"time"
)

const ModelID = "claude-haiku-5-5"
const Endpoint = "https://api.anthropic.com/v1/messages"

type Provider struct {
	a        api.API
	endpoint string
	http     *http.Client
}

func Plugin(endpoint string, client *http.Client) api.Plugin {
	if endpoint == "" {
		endpoint = Endpoint
	}
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Provider redirects refused") }}
	}
	return api.Plugin{Name: "anthropic", Setup: func(a api.API) error {
		if err := a.Define("anthropic.request", api.Transform); err != nil {
			return err
		}
		if err := a.Define("anthropic.piece", api.Observe); err != nil {
			return err
		}
		return a.Provide("provider.anthropic", &Provider{a, endpoint, client})
	}}
}
func (p *Provider) Catalog() []api.Model {
	return []api.Model{{ID: ModelID, Provider: "anthropic", Context: 1000000, Output: 128000, Thinking: []string{"off", "low", "medium", "high"}}}
}
func (p *Provider) Access(id string) (api.ModelAccess, error) {
	if id != ModelID {
		return nil, errors.New("only claude-haiku-5-5 is allowed for real inference")
	}
	return &access{p}, nil
}

type access struct{ p *Provider }

func (a *access) Model() api.Model { return a.p.Catalog()[0] }
func (a *access) Generate(ctx context.Context, r api.Request, emit func(api.Part)) (api.Response, error) {
	p := a.p
	prepared, err := p.a.Invoke(ctx, "anthropic.request", r)
	if err != nil {
		return api.Response{}, err
	}
	r = prepared.(api.Request)
	if r.MaxOutput <= 0 || r.MaxOutput > a.Model().Output {
		return api.Response{}, errors.New("invalid output limit")
	}
	thinking := map[string]any{"type": "adaptive"}
	effort := r.Thinking
	switch effort {
	case "off":
		thinking["type"] = "disabled"
		effort = "low"
	case "low", "medium", "high":
	default:
		return api.Response{}, errors.New("unsupported thinking level")
	}
	messages, err := encodeMessages(r.Messages)
	if err != nil {
		return api.Response{}, err
	}
	body := map[string]any{"model": ModelID, "stream": true, "max_tokens": r.MaxOutput, "messages": messages, "thinking": thinking, "output_config": map[string]any{"effort": effort}}
	if r.System != "" {
		body["system"] = r.System
	}
	if len(r.Tools) > 0 {
		var tools []any
		for _, t := range r.Tools {
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.Input})
		}
		body["tools"] = tools
	}
	store, err := p.a.Get("credentials")
	if err != nil {
		return api.Response{}, &api.ModelError{Kind: "credentials", Message: "credential store unavailable"}
	}
	key, err := store.(api.Credentials).Get(ctx, "anthropic")
	if err != nil {
		return api.Response{}, &api.ModelError{Kind: "credentials", Message: "Anthropic credential unavailable"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(api.JSON(body)))
	if err != nil {
		return api.Response{}, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("anthropic-version", "2026-10-21")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	response, err := p.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return api.Response{}, ctx.Err()
		}
		return api.Response{}, &api.ModelError{Kind: "temporary", Message: "Anthropic transport failed"}
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
		return api.Response{}, classify(response.StatusCode, b)
	}
	return parse(response.Body, func(part api.Part) { _, _ = p.a.Invoke(ctx, "anthropic.piece", part); emit(part) })
}
func encodeMessages(messages []api.Message) ([]map[string]any, error) {
	var out []map[string]any
	for _, m := range messages {
		role := m.Role
		var content []any
		if m.Result != nil {
			role = "user"
			content = append(content, map[string]any{"type": "tool_result", "tool_use_id": reference(m.Result.Call, m.Result.Reference), "content": m.Result.Content.Text(), "is_error": m.Result.Status != "completed"})
		} else {
			for _, part := range m.Content {
				switch {
				case part.Type == "tool_call" && part.Call != nil:
					content = append(content, map[string]any{"type": "tool_use", "id": reference(part.Call.ID, part.Call.Reference), "name": part.Call.Name, "input": part.Call.Input})
				case part.Type == "text":
					if part.Text != "" {
						content = append(content, map[string]any{"type": "text", "text": part.Text})
					}
				case len(part.Data) > 0:
					var raw any
					if err := json.Unmarshal(part.Data, &raw); err != nil {
						return nil, err
					}
					content = append(content, raw)
				default:
					return nil, fmt.Errorf("Anthropic cannot encode content type %s", part.Type)
				}
			}
		}
		if len(content) == 0 {
			continue
		}
		if role != "user" && role != "assistant" {
			return nil, errors.New("invalid model message role")
		}
		// Consecutive user tool results must be sent together, immediately after tool_use.
		if len(out) > 0 && out[len(out)-1]["role"] == role {
			previous := out[len(out)-1]["content"].([]any)
			out[len(out)-1]["content"] = append(previous, content...)
		} else {
			out = append(out, map[string]any{"role": role, "content": content})
		}
	}
	return out, nil
}
func reference(id, ref string) string {
	if ref != "" {
		return ref
	}
	return id
}
func classify(status int, body []byte) error {
	kind := "failed"
	low := strings.ToLower(string(body))
	switch {
	case status == 401 || status == 403:
		kind = "credentials"
	case strings.Contains(low, "prompt is too long") || strings.Contains(low, "context length") || strings.Contains(low, "context window"):
		kind = "context_too_large"
	case status == 429 || status >= 500:
		kind = "temporary"
	}
	// Never expose raw vendor error text or a request header to the Runtime.
	return &api.ModelError{Kind: kind, Message: fmt.Sprintf("Anthropic request failed (HTTP %d)", status)}
}

type block struct {
	raw   map[string]any
	input strings.Builder
}

func parse(reader io.Reader, emit func(api.Part)) (api.Response, error) {
	var out api.Response
	blocks := map[int]*block{}
	started, finished := false, false
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	var data []string
	handle := func(payload string) error {
		var e struct {
			Type         string
			Index        int
			ContentBlock map[string]any `json:"content_block"`
			Delta        map[string]any
			Message      struct {
				Usage struct {
					Input  int `json:"input_tokens"`
					Output int `json:"output_tokens"`
					Cached int `json:"cache_read_input_tokens"`
				}
			}
			Usage struct {
				Output int `json:"output_tokens"`
			}
		}
		if err := json.Unmarshal([]byte(payload), &e); err != nil {
			return &api.ModelError{Kind: "failed", Message: "malformed Anthropic stream"}
		}
		switch e.Type {
		case "message_start":
			started = true
			out.Usage = api.Usage{Input: e.Message.Usage.Input, Output: e.Message.Usage.Output, Cached: e.Message.Usage.Cached}
		case "content_block_start":
			blocks[e.Index] = &block{raw: e.ContentBlock}
			if text, ok := e.ContentBlock["text"].(string); ok && text != "" {
				emit(api.Part{Type: "text", Text: text})
			}
		case "content_block_delta":
			b, ok := blocks[e.Index]
			if !ok {
				return errors.New("stream delta without a block")
			}
			switch e.Delta["type"] {
			case "text_delta":
				text, _ := e.Delta["text"].(string)
				old, _ := b.raw["text"].(string)
				b.raw["text"] = old + text
				emit(api.Part{Type: "text", Text: text})
			case "thinking_delta":
				text, _ := e.Delta["thinking"].(string)
				old, _ := b.raw["thinking"].(string)
				b.raw["thinking"] = old + text
				emit(api.Part{Type: "reasoning", Text: text})
			case "signature_delta":
				sig, _ := e.Delta["signature"].(string)
				old, _ := b.raw["signature"].(string)
				b.raw["signature"] = old + sig
			case "input_json_delta":
				text, _ := e.Delta["partial_json"].(string)
				b.input.WriteString(text)
				emit(api.Part{Type: "tool_input", Text: text})
			default:
				deltas, _ := b.raw["_stream_deltas"].([]any)
				b.raw["_stream_deltas"] = append(deltas, e.Delta)
			}
		case "message_delta":
			if reason, ok := e.Delta["stop_reason"].(string); ok {
				switch reason {
				case "end_turn", "stop_sequence":
					out.Stop = "finished"
				case "tool_use":
					out.Stop = "tools"
				case "max_tokens":
					out.Stop = "output_limit"
				case "refusal":
					out.Stop = "refused"
				default:
					out.Stop = "failed"
				}
			}
			out.Usage.Output = e.Usage.Output
		case "message_stop":
			finished = true
		case "error":
			return classify(500, []byte(payload))
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if len(data) > 0 {
				if err := handle(strings.Join(data, "\n")); err != nil {
					return out, err
				}
				data = nil
			}
			if finished {
				break
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return out, &api.ModelError{Kind: "temporary", Message: "Anthropic stream read failed"}
	}
	if !started || !finished || out.Stop == "" {
		return out, &api.ModelError{Kind: "temporary", Message: "incomplete Anthropic stream"}
	}
	var indices []int
	for index := range blocks {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	for _, index := range indices {
		b := blocks[index]
		typ, _ := b.raw["type"].(string)
		if b.input.Len() > 0 {
			var input any
			if err := json.Unmarshal([]byte(b.input.String()), &input); err != nil {
				return out, errors.New("invalid streamed tool input")
			}
			b.raw["input"] = input
		}
		part := api.Part{Type: typ, Data: api.JSON(b.raw)}
		switch typ {
		case "text":
			part.Text, _ = b.raw["text"].(string)
		case "thinking":
			part.Type = "reasoning"
			part.Text, _ = b.raw["thinking"].(string)
		case "tool_use":
			part.Type = "tool_call"
			id, _ := b.raw["id"].(string)
			name, _ := b.raw["name"].(string)
			if id == "" || name == "" {
				return out, errors.New("invalid Anthropic tool call")
			}
			part.Call = &api.Call{ID: id, Name: name, Input: api.JSON(b.raw["input"]), Origin: "model"}
		}
		out.Content = append(out.Content, part)
	}
	return out, nil
}
