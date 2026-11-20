package subscription

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

//go:embed models.json
var builtIn []byte
var levels = []string{"off", "minimal", "low", "medium", "high", "xhigh"}

type Model struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Context   int               `json:"contextWindow"`
	MaxTokens int               `json:"maxTokens"`
	Effort    map[string]string `json:"effort"`
}

func Catalog(v Vendor, overrides map[Vendor][]Model) ([]Model, error) {
	var all map[Vendor][]Model
	if err := json.Unmarshal(builtIn, &all); err != nil {
		return nil, err
	}
	models := all[v]
	for _, m := range overrides[v] {
		if m.ID == "" || m.Context <= 0 || m.MaxTokens <= 0 {
			return nil, fmt.Errorf("invalid model for %s", v)
		}
		models = slices.DeleteFunc(models, func(old Model) bool { return old.ID == m.ID })
		models = append(models, m)
	}
	return models, nil
}
func (v Vendor) endpoint() string {
	if v == Codex {
		return "https://chatgpt.com/backend-api/codex/responses"
	}
	return "https://api.x.ai/v1/responses"
}
func Provider(v Vendor, models []Model, auth AuthFile) modular.Provider {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.ResponseHeaderTimeout = 300 * time.Second
	return provider(v, models, auth, v.endpoint(), &http.Client{Transport: transport, CheckRedirect: noRedirect}, oauthDefaults())
}
func provider(v Vendor, models []Model, auth AuthFile, endpoint string, client *http.Client, oauth oauthClient) modular.Provider {
	info := func() []modular.ModelInfo {
		out := make([]modular.ModelInfo, 0, len(models))
		for _, m := range models {
			thinking := []string{}
			for _, l := range levels {
				if _, ok := m.Effort[l]; ok {
					thinking = append(thinking, l)
				}
			}
			out = append(out, modular.ModelInfo{ModelRef: modular.ModelRef{Provider: string(v), ID: m.ID}, ContextWindow: m.Context, MaxOutput: m.MaxTokens, Thinking: thinking, Reasoning: slices.ContainsFunc(thinking, func(s string) bool { return s != "off" }), Input: []string{"text", "image"}})
		}
		return out
	}
	return modular.Provider{ID: string(v), Models: info, Available: func() bool { l, e := auth.Login(string(v)); return e == nil && l != nil }, Request: func(ctx context.Context, ref modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
		index := slices.IndexFunc(models, func(m Model) bool { return m.ID == ref.ID })
		if index < 0 {
			return modular.AssistantMessage{}, errors.New("unknown model")
		}
		b, err := json.Marshal(requestBody(v, models[index], r))
		if err != nil {
			return modular.AssistantMessage{}, err
		}
		refresh := func(ctx context.Context, l Login) (Login, error) { return oauth.refresh(ctx, v, l) }
		l, err := auth.Current(ctx, string(v), nil, refresh)
		if err != nil {
			return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Credentials, Message: err.Error()}
		}
		for attempt := 0; ; attempt++ {
			req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(b))
			if err != nil {
				return modular.AssistantMessage{}, err
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "text/event-stream")
			req.Header.Set("Authorization", "Bearer "+l.Secret())
			req.Header.Set("User-Agent", "modular-agent/0.1.0")
			if v == Codex {
				var id string
				if l.Account != nil {
					id = *l.Account
				} else {
					id, err = account(l.Secret())
					if err != nil {
						return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Credentials, Message: err.Error()}
					}
				}
				req.Header.Set("ChatGPT-Account-Id", id)
				req.Header.Set("OpenAI-Beta", "responses=experimental")
				req.Header.Set("Originator", "pi")
				req.Header.Set("Session-Id", r.SessionID)
				req.Header.Set("X-Client-Request-Id", r.SessionID)
			}
			res, err := client.Do(req)
			if err != nil {
				if ctx.Err() != nil {
					return modular.AssistantMessage{}, ctx.Err()
				}
				return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Temporary, Message: fmt.Sprintf("could not reach %s: %v", v.Label(), err)}
			}
			if ok(res.StatusCode) {
				defer res.Body.Close()
				return readStream(v, res.Body, pc)
			}
			if res.StatusCode == 401 && attempt == 0 && l.Type == "oauth" {
				res.Body.Close()
				l, err = auth.Current(ctx, string(v), &l, refresh)
				if err != nil {
					return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Credentials, Message: err.Error()}
				}
				continue
			}
			data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
			res.Body.Close()
			var body map[string]any
			if json.Unmarshal(data, &body) != nil {
				body = map[string]any{"message": firstRunes(string(data), 500)}
			}
			if e, ok := body["error"].(map[string]any); ok {
				body = e
			}
			failure := modelError(res.StatusCode, body)
			if failure.Kind == modular.Credentials {
				failure.Message += fmt.Sprintf(" Run `ma login %s` to sign in again.", v)
			}
			return modular.AssistantMessage{}, failure
		}
	}}
}
func firstRunes(s string, n int) string { r := []rune(s); return string(r[:min(n, len(r))]) }
func partStr(p modular.Part, k string) string {
	var s string
	_ = json.Unmarshal(p.Fields[k], &s)
	return s
}
func decodeField(s map[string]any, k string) map[string]any { m, _ := s[k].(map[string]any); return m }
func requestBody(v Vendor, m Model, r modular.ModelRequest) map[string]any {
	input := []any{}
	if v == Xai && r.SystemPrompt != "" {
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
				Provider Vendor           `json:"provider"`
				Output   []map[string]any `json:"output"`
			}
			if json.Unmarshal(msg.ProviderData, &previous) == nil && previous.Provider == v && previous.Output != nil {
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
	out := map[string]any{"model": m.ID, "stream": true, "store": false, "include": []string{"reasoning.encrypted_content"}, "tool_choice": "auto", "parallel_tool_calls": true, "input": input}
	var tools []any
	for _, t := range r.Tools {
		tools = append(tools, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": t.Parameters, "strict": false})
	}
	if len(tools) > 0 {
		out["tools"] = tools
	}
	asked, _ := r.Settings["reasoning"].(string)
	for i := slices.Index(levels, asked); i >= 0; i-- {
		if effort, ok := m.Effort[levels[i]]; ok {
			out["reasoning"] = map[string]string{"effort": effort, "summary": "auto"}
			break
		}
	}
	if v == Codex {
		sys := r.SystemPrompt
		if sys == "" {
			sys = "You are a helpful assistant."
		}
		out["instructions"] = sys
		out["text"] = map[string]string{"verbosity": "low"}
		out["prompt_cache_key"] = r.SessionID
	} else if cap := number(r.Settings, "maxOutput", 0); cap > 0 {
		out["max_output_tokens"] = min(cap, m.MaxTokens)
	}
	return out
}
func modelError(status int, e map[string]any) *modular.ModelError {
	code := str(e, "code")
	if code == "" {
		code = str(e, "type")
	}
	message := str(e, "message")
	if message == "" {
		message = str(e, "detail")
	}
	if message == "" {
		message = "the model service refused the request"
	}
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
	if code != "" {
		message += " (" + code + ")"
	} else if status > 0 {
		message += fmt.Sprintf(" (HTTP %d)", status)
	}
	return &modular.ModelError{Kind: kind, Message: message}
}
func readStream(v Vendor, body io.Reader, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
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
			return err
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
			return modelError(0, decodeField(decodeField(event, "response"), "error"))
		case "error":
			e := decodeField(event, "error")
			if e == nil {
				e = event
			}
			return modelError(0, e)
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
		return modular.AssistantMessage{}, &modular.ModelError{Kind: modular.Temporary, Message: err.Error()}
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
	return response(v, done)
}
func raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func response(v Vendor, r map[string]any) (modular.AssistantMessage, error) {
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
			result.Content = append(result.Content, modular.Part{Type: "reasoning", Fields: map[string]json.RawMessage{"providerData": raw(map[string]any{"provider": v, "item": item})}})
		default:
			addUnknown(&result, item)
		}
	}
	if str(r, "status") == "incomplete" {
		result.Stop = "length"
	} else {
		result.ProviderData = raw(map[string]any{"provider": v, "output": items})
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
