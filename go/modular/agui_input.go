package modular

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/json/jsontext"
	"io"
	"mime"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type agObject = map[string]any

func agString(m agObject, k string) string { s, _ := m[k].(string); return s }
func agMap(v any) agObject                 { m, _ := v.(map[string]any); return m }
func agEqual(a, b any) bool                { return portable.EqualJSON(api.JSON(a), api.JSON(b)) }

type agCode string

func (c agCode) Error() string { return string(c) }

const (
	invalid     agCode = "invalid_request"
	denied      agCode = "refused"
	stale       agCode = "conflict"
	missing     agCode = "not_found"
	withheld    agCode = "output_withheld"
	tooLarge    agCode = "result_too_large"
	unavailable agCode = "unavailable"
)

func agRead(r *http.Request) (agObject, error) {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		return nil, invalid
	}
	if r.ContentLength > wswire.MaxFrame {
		return nil, tooLarge
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, wswire.MaxFrame+1))
	if err != nil {
		return nil, invalid
	}
	if len(raw) > wswire.MaxFrame {
		return nil, tooLarge
	}
	return agDecodeObject(raw)
}

func agDecodeObject(raw []byte) (agObject, error) {
	// jsontext enforces unique decoded keys and well-formed UTF-8 (including escaped surrogate pairs).
	if !jsontext.Value(raw).IsValid() {
		return nil, invalid
	}
	depth := 0
	quoted := false
	for i := 0; i < len(raw); i++ {
		switch {
		case quoted && raw[i] == '\\':
			i++
		case raw[i] == '"':
			quoted = !quoted
		case !quoted && (raw[i] == '{' || raw[i] == '['):
			depth++
			if depth > 64 {
				return nil, invalid
			}
		case !quoted && (raw[i] == '}' || raw[i] == ']'):
			depth--
		}
	}
	var m agObject
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&m) != nil || m == nil {
		return nil, invalid
	}
	return m, nil
}

// Strip unknown fields before comparison. An open payload (including metadata) is never authority.
func agShape(m agObject, required, optional string, warn func(string)) bool {
	if m == nil {
		return false
	}
	allowed := strings.Fields(required + " " + optional)
	for _, k := range strings.Fields(required) {
		if m[k] == nil {
			return false
		}
	}
	for k := range m {
		if !slices.Contains(allowed, k) {
			warn(k)
			delete(m, k)
		}
	}
	return true
}
func agStrings(m agObject, keys string) bool {
	for _, k := range strings.Fields(keys) {
		if v, ok := m[k]; ok {
			if _, ok := v.(string); !ok {
				return false
			}
		}
	}
	return true
}
func agMetadata(m agObject) bool { v, ok := m["metadata"]; return !ok || agMap(v) != nil }

type agInput struct {
	thread, run               string
	messages, offers, answers []agObject
}

var agVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func agParse(m agObject, warn func(string)) (in agInput, err error) {
	if !agShape(m, "threadId runId messages protocolVersion", "tools resume context state parentRunId forwardedProps", warn) || !agStrings(m, "threadId runId protocolVersion parentRunId") {
		return in, invalid
	}
	in.thread, in.run = agString(m, "threadId"), agString(m, "runId")
	if in.thread == "" || in.run == "" {
		return in, invalid
	}
	v := agString(m, "protocolVersion")
	if major := agVersion.FindStringSubmatch(v); major != nil && major[1] != "1" {
		return in, agCode("not_supported")
	}
	if v != "1.0" {
		warn("protocolVersion")
	}
	for _, k := range []string{"tools", "context", "resume", "messages"} {
		raw, ok := m[k]
		if !ok {
			continue
		}
		list, ok := raw.([]any)
		if !ok {
			return in, invalid
		}
		for _, item := range list {
			x := agMap(item)
			switch k {
			case "tools":
				if !agShape(x, "name description", "parameters metadata", warn) || !agStrings(x, "name description") || !agMetadata(x) {
					return in, invalid
				}
				if p, ok := x["parameters"]; ok && p == nil {
					return in, invalid
				}
				in.offers = append(in.offers, x)
			case "context":
				if !agShape(x, "description value", "", warn) || !agStrings(x, "description value") {
					return in, invalid
				}
				warn("context")
			case "resume":
				if !agShape(x, "interruptId status", "payload metadata", warn) || !agStrings(x, "interruptId status") || !agMetadata(x) || !slices.Contains([]string{"resolved", "cancelled"}, agString(x, "status")) {
					return in, invalid
				}
				if p, ok := x["payload"]; ok && p == nil {
					return in, invalid
				}
				in.answers = append(in.answers, x)
			case "messages":
				if !agMessage(x, warn) {
					return in, invalid
				}
				if x["role"] != "reasoning" && x["role"] != "activity" {
					in.messages = append(in.messages, x)
				}
			}
		}
	}
	return in, nil
}
func agMessage(m agObject, warn func(string)) bool {
	common := "subagentRunId encryptedValue metadata"
	req := "id role "
	opt := common
	switch agString(m, "role") {
	case "assistant":
		opt += " name content toolCalls"
	case "tool":
		req += "content toolCallId"
		opt += " error"
	case "user", "system", "developer":
		req += "content"
		opt += " name"
	case "reasoning":
		req += "content"
	case "activity":
		req += "activityType content"
		opt = "subagentRunId metadata"
	default:
		return false
	}
	if !agShape(m, req, opt, warn) || !agStrings(m, "id role name subagentRunId encryptedValue toolCallId error activityType") || !agMetadata(m) || agString(m, "id") == "" {
		return false
	}
	if raw, ok := m["toolCalls"]; ok {
		calls, ok := raw.([]any)
		if !ok {
			return false
		}
		for _, v := range calls {
			c := agMap(v)
			if !agShape(c, "id type function", "metadata encryptedValue", warn) || !agStrings(c, "id encryptedValue") || c["type"] != "function" || !agMetadata(c) {
				return false
			}
			f := agMap(c["function"])
			if !agShape(f, "name arguments", "", warn) || !agStrings(f, "name arguments") {
				return false
			}
		}
	}
	if m["role"] == "activity" {
		return agMap(m["content"]) != nil
	}
	if _, present := m["content"]; !present {
		return m["role"] == "assistant"
	}
	if _, ok := m["content"].(string); ok {
		return true
	}
	if m["role"] != "user" && m["role"] != "tool" {
		return false
	}
	parts, ok := m["content"].([]any)
	if !ok {
		return false
	}
	for _, v := range parts {
		p := agMap(v)
		switch agString(p, "type") {
		case "text":
			if !agShape(p, "type text", "metadata", warn) || !agStrings(p, "text") {
				return false
			}
		case "image", "audio", "video", "document":
			if !agShape(p, "type source", "id metadata", warn) || !agStrings(p, "id") {
				return false
			}
			s := agMap(p["source"])
			switch agString(s, "type") {
			case "data":
				if !agShape(s, "type value mimeType", "", warn) {
					return false
				}
			case "file", "url":
				if !agShape(s, "type value", "mimeType provider", warn) {
					return false
				}
			default:
				return false
			}
			if !agStrings(s, "value mimeType provider") {
				return false
			}
		default:
			return false
		}
		if v, ok := p["metadata"]; ok && v == nil {
			return false
		}
	}
	return true
}
func agContent(value any, warn func(string)) (api.Content, error) {
	if s, ok := value.(string); ok {
		return api.Text(s), nil
	}
	out := api.Content{}
	for _, v := range value.([]any) {
		p := agMap(v)
		if p["type"] == "text" {
			out = append(out, api.Part{Type: "text", Text: agString(p, "text")})
			continue
		}
		src := agMap(p["source"])
		if p["type"] != "image" || src["type"] != "data" {
			warn("content")
			continue
		}
		mimeType, data := agString(src, "mimeType"), agString(src, "value")
		if !strings.HasPrefix(mimeType, "image/") || strings.ContainsAny(mimeType, "; \t\r\n") || strings.ContainsAny(data, "\r\n") {
			return nil, invalid
		}
		if _, err := base64.StdEncoding.Strict().DecodeString(data); err != nil {
			return nil, invalid
		}
		out = append(out, api.Part{Type: "image", Data: api.JSON(agObject{"type": "image", "mimeType": mimeType, "data": data})})
	}
	return out, nil
}
func agBody(content api.Content) any {
	parts := []any{}
	image := false
	for _, p := range content {
		switch p.Type {
		case "text":
			parts = append(parts, agObject{"type": "text", "text": p.Text})
		case "image":
			var media struct{ Data, MimeType string }
			raw := p.Data
			if len(raw) == 0 {
				raw = p.Wire
			}
			if json.Unmarshal(raw, &media) == nil && media.MimeType != "" {
				parts = append(parts, agObject{"type": "image", "source": agObject{"type": "data", "value": media.Data, "mimeType": media.MimeType}})
				image = true
			}
		}
	}
	if !image {
		return content.Text()
	}
	return parts
}
