package subscription

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

func partStr(p modular.Part, k string) string {
	var s string
	_ = json.Unmarshal(p.Fields[k], &s)
	return s
}
func decodeField(s map[string]any, k string) map[string]any { m, _ := s[k].(map[string]any); return m }
func (c responsesConfig) newRequest(ctx context.Context, body []byte, l Login, sessionID string, identity string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+l.Secret())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "modular-agent/"+modular.Version)
	if !c.systemMessage {
		var id string
		if l.Account != nil {
			id = *l.Account
		} else {
			id, err = account(l.Secret())
			if err != nil {
				return nil, &modular.ModelError{Kind: modular.Credentials, Message: "could not read the ChatGPT stream"}
			}
		}
		req.Header.Set("ChatGPT-Account-Id", id)
		req.Header.Set("OpenAI-Beta", "responses=experimental")
		req.Header.Set("Originator", identity)
		req.Header.Set("Session-Id", sessionID)
		req.Header.Set("X-Client-Request-Id", sessionID)
	}
	return req, nil
}

func (c responsesConfig) requestBody(m subscriptionModel, r modular.ModelRequest) map[string]any {
	input := []any{}
	if c.systemMessage && r.SystemPrompt != "" {
		input = append(input, map[string]any{"role": "system", "content": r.SystemPrompt})
	}
	for _, msg := range r.Messages {
		var images []any
		for _, p := range msg.Content {
			if p.Type == "image" {
				images = append(images, map[string]any{"type": "input_image", "image_url": "data:" + partStr(p, "mimeType") + ";base64," + partStr(p, "data")})
			}
		}
		switch msg.Role {
		case "assistant":
			var calls []modular.Part
			for _, p := range msg.Content {
				if p.Type == "toolCall" {
					calls = append(calls, p)
				}
			}
			var previous struct {
				Provider string           `json:"provider"`
				Output   []map[string]any `json:"output"`
			}
			if json.Unmarshal(msg.ProviderData, &previous) == nil && previous.Provider == c.id && previous.Output != nil {
				i := 0
				for _, item := range previous.Output {
					if item["type"] == "function_call" && i < len(calls) {
						item["call_id"] = partStr(calls[i], "id")
						i++
					}
					input = append(input, item)
				}
				continue
			}
			if text := msg.Content.Text(); text != "" {
				input = append(input, map[string]any{"role": "assistant", "content": text})
			}
			for _, p := range calls {
				input = append(input, map[string]any{"type": "function_call", "call_id": partStr(p, "id"), "name": partStr(p, "name"), "arguments": string(p.Fields["arguments"])})
			}
		case "toolResult":
			input = append(input, map[string]any{"type": "function_call_output", "call_id": msg.ToolCallID, "output": msg.Content.Text()})
			if len(images) > 0 {
				input = append(input, map[string]any{"role": "user", "content": images})
			}
		default:
			var content any = msg.Content.Text()
			if len(images) > 0 {
				content = append([]any{map[string]any{"type": "input_text", "text": msg.Content.Text()}}, images...)
			}
			input = append(input, map[string]any{"role": msg.Role, "content": content})
		}
	}
	out := map[string]any{"model": m.Info.ID, "stream": true, "store": false, "include": []string{"reasoning.encrypted_content"}, "tool_choice": "auto", "parallel_tool_calls": true, "input": input}
	var tools []any
	for _, t := range r.Tools {
		tools = append(tools, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": t.Parameters, "strict": false})
	}
	if len(tools) > 0 {
		out["tools"] = tools
	}
	asked, _ := r.Settings["reasoning"].(string)
	for i := slices.Index(levels, asked); i >= 0; i-- {
		if effort, ok := m.Levels[levels[i]]; ok {
			out["reasoning"] = map[string]any{"effort": effort.Reasoning.Effort, "summary": "auto"}
			break
		}
	}
	if c.systemMessage {
		if cap := outputLimit(r.Settings["maxOutput"], m.Info.MaxOutput); cap > 0 {
			out["max_output_tokens"] = cap
		}
	} else {
		sys := r.SystemPrompt
		if sys == "" {
			sys = "You are a helpful assistant."
		}
		out["instructions"] = sys
		out["text"] = map[string]string{"verbosity": "low"}
		out["prompt_cache_key"] = r.SessionID
	}
	return out
}

// Settings are native Go values in process and JSON numbers across the binding.
func outputLimit(value any, limit int) int {
	var n uint64
	switch v := value.(type) {
	case int:
		n = uint64(max(v, 0))
	case int64:
		n = uint64(max(v, 0))
	case uint64:
		n = v
	case json.Number:
		n, _ = strconv.ParseUint(string(v), 10, 64)
	case float64:
		if v > 0 && v < 1<<64 && v == float64(uint64(v)) {
			n = uint64(v)
		}
	}
	return int(min(n, uint64(limit)))
}

func (c responsesConfig) modelError(status int, e map[string]any) *modular.ModelError {
	code := str(e, "code")
	if code == "" {
		code = str(e, "type")
	}
	message := c.label + " refused the request"

	kind := modular.Other
	switch code {
	case "context_length_exceeded", "context_window_exceeded":
		kind = modular.ContextTooLarge
	case "usage_limit_reached", "usage_not_included", "insufficient_quota":
	case "invalid_api_key", "authentication_error", "token_expired":
		kind = modular.Credentials
	case "rate_limit_exceeded", "server_error", "overloaded":
		kind = modular.Temporary
	case "content_policy_violation":
		kind = modular.ModelRefused
	default:
		if status == 401 || status == 403 {
			kind = modular.Credentials
		} else if status == 429 || status >= 500 && status < 600 {
			kind = modular.Temporary
		}
	}
	if status > 0 {
		message += fmt.Sprintf(" (HTTP %d)", status)
	}
	if kind == modular.Credentials {
		message += ". Sign in again."
	}

	return &modular.ModelError{Kind: kind, Message: message}
}
func (c responsesConfig) readStream(body io.Reader, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
	const limit = 16 << 20
	scan := bufio.NewScanner(body)
	scan.Buffer(make([]byte, 4096), limit)
	var data strings.Builder
	var done map[string]any
	var items []any
	handle := func() error {
		if data.Len() == 0 {
			return nil
		}
		text := data.String()
		data.Reset()
		if text == "[DONE]" {
			return nil
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(text), &event); err != nil {
			return errors.New("invalid " + c.label + " stream event")
		}
		switch str(event, "type") {
		case "response.output_text.delta":
			pc.Piece("text", str(event, "delta"))
		case "response.reasoning_summary_text.delta":
			pc.Piece("reasoning", str(event, "delta"))
		case "response.function_call_arguments.delta":
			pc.Piece("toolInput", str(event, "delta"), str(event, "item_id"))
		case "response.output_item.done":
			items = append(items, event["item"])
		case "response.completed", "response.incomplete", "response.done":
			done = decodeField(event, "response")
		case "response.failed":
			return c.modelError(0, decodeField(decodeField(event, "response"), "error"))
		case "error":
			e := decodeField(event, "error")
			if e == nil {
				e = event
			}
			return c.modelError(0, e)
		}
		return nil
	}
	for scan.Scan() {
		s := scan.Text()
		if p, ok := strings.CutPrefix(s, "data:"); ok {
			if data.Len()+len(p)+1 >= limit {
				return modular.AssistantMessage{}, errors.New("model event too large")
			}
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimLeft(p, " \t"))
		} else if s == "" {
			if err := handle(); err != nil {
				return modular.AssistantMessage{}, err
			}
		}
	}
	if err := scan.Err(); err != nil {
		return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Temporary, Message: "could not read the " + c.label + " stream"}
	}
	if err := handle(); err != nil {
		return modular.AssistantMessage{}, err
	}
	if done == nil {
		return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Temporary, Message: "the model stream ended before a complete response"}
	}
	if o, _ := done["output"].([]any); len(o) == 0 && len(items) > 0 {
		done["output"] = items
	}
	return c.response(done)
}
func raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func (c responsesConfig) response(r map[string]any) (modular.AssistantMessage, error) {
	result := modular.AssistantMessage{Stop: "finished"}
	items, ok := r["output"].([]any)
	if !ok {
		return result, errors.New("the model response has no output")
	}
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		switch str(item, "type") {
		case "message":
			parts, _ := item["content"].([]any)
			for _, value := range parts {
				p, _ := value.(map[string]any)
				switch str(p, "type") {
				case "output_text":
					result.Content = append(result.Content, modular.Text(str(p, "text"))...)
				case "refusal":
					s := str(p, "refusal")
					if s == "" {
						s = "model refused"
					}
					result.Content = append(result.Content, modular.Text(s)...)
				default:
					addUnknown(&result, p)
				}
			}
		case "function_call":
			if str(r, "status") == "incomplete" {
				continue
			}
			id, name := str(item, "call_id"), str(item, "name")
			if id == "" || name == "" {
				return result, errors.New("missing tool call id or name")
			}
			args := strings.TrimSpace(str(item, "arguments"))
			if args == "" {
				args = "{}"
			}
			if !json.Valid([]byte(args)) {
				return result, errors.New("the model sent tool arguments that are not JSON")
			}
			result.Content = append(result.Content, modular.Part{Type: "toolCall", Fields: map[string]json.RawMessage{"id": raw(id), "name": raw(name), "arguments": json.RawMessage(args)}})
			result.Stop = "toolUse"
		case "reasoning":
			if c.systemMessage {
				result.Content = append(result.Content, modular.Part{Type: "reasoning", Fields: map[string]json.RawMessage{"providerData": raw(map[string]any{"provider": c.id, "item": item})}})
				continue
			}
			summary, _ := item["summary"].([]any)
			for _, entry := range summary {
				piece, _ := entry.(map[string]any)
				if text := str(piece, "text"); text != "" {
					result.Content = append(result.Content, modular.Part{Type: "reasoning", Text: text})
				}
			}
		default:
			addUnknown(&result, item)
		}
	}
	if str(r, "status") == "incomplete" {
		result.Stop = "length"
	}
	if c.systemMessage || result.Stop != "length" {
		result.ProviderData = raw(map[string]any{"provider": c.id, "output": items})
	}
	usage := decodeField(r, "usage")
	result.Usage = modular.Usage{Input: number(usage, "input_tokens", 0), Output: number(usage, "output_tokens", 0), CacheRead: number(decodeField(usage, "input_tokens_details"), "cached_tokens", 0)}
	return result, nil
}
func addUnknown(result *modular.AssistantMessage, p map[string]any) {
	if kind := str(p, "type"); kind != "" {
		fields := make(map[string]json.RawMessage, len(p))
		for k, v := range p {
			if k != "type" {
				fields[k] = raw(v)
			}
		}
		result.Content = append(result.Content, modular.Part{Type: kind, Fields: fields})
	}
}
