package portable

import (
	"bytes"
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"strings"
)

// Object preserves unknown JSON numbers without rounding them through float64.
type Object map[string]any
type object = Object

func (o *Object) UnmarshalJSON(raw []byte) error {
	var v map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&v); err != nil {
		return err
	}
	*o = v
	return nil
}

func obj(raw json.RawMessage) object {
	var v object
	_ = json.Unmarshal(raw, &v)
	if v == nil {
		v = object{}
	}
	return v
}
func str(v object, key string) string   { s, _ := v[key].(string); return s }
func boolean(v object, key string) bool { b, _ := v[key].(bool); return b }
func real(v object, key string) float64 {
	switch n := v[key].(type) {
	case json.Number:
		f, _ := n.Float64()
		return f
	case float64:
		return n
	}
	return 0
}
func number(v object, key string) int { return int(real(v, key)) }
func asObject(v any) object {
	// Objects decoded with UseNumber already have the right shape. The
	// callers that edit the result own their decoded wire object.
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	if v == nil {
		return object{}
	}
	return obj(api.JSON(v))
}
func contentOut(c api.Content) []any {
	out := []any{}
	for _, p := range c {
		v := object{}
		if len(p.Wire) > 0 {
			v = obj(p.Wire)
		}
		v["type"] = p.Type
		switch {
		case p.Call != nil:
			v["type"] = "toolCall"
			v["id"] = p.Call.ID
			v["name"] = p.Call.Name
			v["arguments"] = p.Call.Input
		case p.Type == "text":
			v["text"] = p.Text
		case p.Type == "reasoning":
			if p.Text != "" {
				v["text"] = p.Text
			}
			if len(p.Data) > 0 {
				v["providerData"] = p.Data
			}
		default:
			if len(p.Wire) == 0 && len(p.Data) > 0 {
				v = obj(p.Data)
				v["type"] = p.Type
			}
		}
		out = append(out, v)
	}
	return out
}
func contentIn(v any) api.Content {
	var parts []json.RawMessage
	_ = json.Unmarshal(api.JSON(v), &parts)
	out := api.Content{}
	for _, raw := range parts {
		v := obj(raw)
		p := api.Part{Type: str(v, "type"), Text: str(v, "text"), Wire: raw}
		if p.Type == "toolCall" {
			p.Type = "tool_call"
			p.Call = &api.Call{ID: str(v, "id"), Name: str(v, "name"), Input: api.JSON(v["arguments"]), Wire: raw}
		}
		if p.Type == "reasoning" {
			if d, ok := v["providerData"]; ok {
				p.Data = api.JSON(d)
			}
		} else if p.Type != "text" && p.Type != "tool_call" {
			p.Data = raw
		}
		out = append(out, p)
	}
	return out
}
func toolOut(t api.Tool) object {
	v := obj(t.Wire)
	v["name"] = t.Name
	v["description"] = t.Description
	v["parameters"] = t.Input
	hints := asObject(v["hints"])
	hints["readOnly"], hints["destructive"], hints["openWorld"], hints["safeToRepeat"] = t.ReadOnly, t.Destructive, t.External, t.SafeRepeat
	v["hints"] = hints
	v["parallel"] = t.Parallel
	if t.Callers != nil {
		v["callers"] = t.Callers
	}
	if len(t.Output) > 0 {
		v["returns"] = t.Output
	}
	return v
}
func toolIn(v object) api.Tool {
	h := asObject(v["hints"])
	var callers []string
	if has(v, "callers") {
		_ = json.Unmarshal(api.JSON(v["callers"]), &callers)
	}
	return api.Tool{Callers: callers, Name: str(v, "name"), Description: str(v, "description"), Input: api.JSON(v["parameters"]), Output: optionalJSON(v, "returns"), ReadOnly: boolean(h, "readOnly"), Destructive: !has(h, "destructive") || boolean(h, "destructive"), External: !has(h, "openWorld") || boolean(h, "openWorld"), SafeRepeat: boolean(h, "safeToRepeat"), Parallel: boolean(v, "parallel"), Wire: api.JSON(v)}
}
func optionalJSON(v object, key string) json.RawMessage {
	if has(v, key) {
		return api.JSON(v[key])
	}
	return nil
}
func has(v object, k string) bool { x, ok := v[k]; return ok && x != nil }
func callOut(c api.Call) object {
	v := obj(c.Wire)
	v["id"] = c.ID
	v["name"] = c.Name
	v["input"] = c.Input
	v["startedBy"] = c.Origin
	set(v, "parentCallId", c.ParentCall, c.ParentCall != "")
	if c.Step != "" {
		v["stepId"] = c.Step
	}
	if c.Actor != "" {
		v["actorId"] = c.Actor
	}
	return v
}
func callIn(v object) api.Call {
	return api.Call{ParentCall: str(v, "parentCallId"), Step: str(v, "stepId"), ID: str(v, "id"), Name: str(v, "name"), Input: api.JSON(v["input"]), Origin: str(v, "startedBy"), Actor: str(v, "actorId"), Wire: api.JSON(v)}
}
func statusOut(s string) string {
	switch s {
	case "unknown":
		return "outcomeUnknown"
	case "not_started":
		return "notStarted"
	}
	return s
}
func statusIn(s string) string {
	switch s {
	case "outcomeUnknown":
		return "unknown"
	case "notStarted":
		return "not_started"
	}
	return s
}
func resultOut(r api.ToolResult) object {
	v := obj(r.Wire)
	v["callId"] = r.Call
	v["status"] = statusOut(r.Status)
	v["content"] = contentOut(r.Content)
	if len(r.Structured) > 0 {
		v["value"] = r.Structured
	}
	return v
}
func resultIn(v object) api.ToolResult {
	r := api.ToolResult{Call: str(v, "callId"), Status: statusIn(str(v, "status")), Content: contentIn(v["content"]), Wire: api.JSON(v)}
	if x, ok := v["value"]; ok {
		r.Structured = api.JSON(x)
	}
	if has(v, "pending") {
		r.Status = "open"
		r.Content = nil
	}
	return r
}
func modelOut(m api.Model) object {
	v := obj(m.Wire)
	v["provider"] = m.Provider
	v["id"] = strings.TrimPrefix(m.ID, m.Provider+"/")
	v["contextWindow"] = m.Context
	v["maxOutput"] = m.Output
	if !has(v, "input") {
		v["input"] = []string{"text"}
	}
	if !has(v, "reasoning") {
		v["reasoning"] = len(m.Thinking) > 1
	}
	v["thinking"] = m.Thinking
	return v
}
func modelIn(v object) api.Model {
	var levels []string
	_ = json.Unmarshal(api.JSON(v["thinking"]), &levels)
	if len(levels) == 0 {
		levels = []string{"off"}
	}
	return api.Model{ID: str(v, "provider") + "/" + str(v, "id"), Provider: str(v, "provider"), Context: number(v, "contextWindow"), Output: number(v, "maxOutput"), Thinking: levels, Wire: api.JSON(v)}
}
func requestOut(r api.Request) object {
	v := obj(r.Wire)
	messages := []any{}
	for _, m := range r.Messages {
		x := obj(m.Wire)
		x["role"] = m.Role
		x["content"] = contentOut(m.Content)
		if m.Role == "assistant" && !has(x, "stop") {
			x["stop"] = "finished"
		}
		if m.Result != nil {
			x["role"] = "toolResult"
			x["content"] = contentOut(m.Result.Content)
			x["toolCallId"] = m.Result.Call
			x["toolName"] = m.Result.Name
			x["isError"] = m.Result.Status != "completed"
		}
		messages = append(messages, x)
	}
	tools := []any{}
	for _, t := range r.Tools {
		tools = append(tools, toolOut(t))
	}
	settings := asObject(v["settings"])
	settings["reasoning"] = r.Thinking
	settings["maxOutput"] = r.MaxOutput
	v["systemPrompt"] = r.System
	v["messages"] = messages
	v["tools"] = tools
	v["settings"] = settings
	return v
}
func requestIn(v object) api.Request {
	r := api.Request{System: str(v, "systemPrompt"), Wire: api.JSON(v)}
	s := asObject(v["settings"])
	r.Thinking = str(s, "reasoning")
	r.MaxOutput = number(s, "maxOutput")
	var messages, tools []object
	_ = json.Unmarshal(api.JSON(v["messages"]), &messages)
	_ = json.Unmarshal(api.JSON(v["tools"]), &tools)
	for _, m := range messages {
		x := api.Message{Role: str(m, "role"), Content: contentIn(m["content"]), Wire: api.JSON(m)}
		if x.Role == "toolResult" {
			status := "completed"
			if boolean(m, "isError") {
				status = "failed"
			}
			x.Role = "tool"
			x.Result = &api.ToolResult{Call: str(m, "toolCallId"), Name: str(m, "toolName"), Content: x.Content, Status: status}
		}
		r.Messages = append(r.Messages, x)
	}
	for _, t := range tools {
		r.Tools = append(r.Tools, toolIn(t))
	}
	return r
}
func stopOut(s string) string {
	switch s {
	case "tools":
		return "toolUse"
	case "output_limit":
		return "length"
	}
	return s
}
func stopIn(s string) string {
	switch s {
	case "toolUse":
		return "tools"
	case "length":
		return "output_limit"
	}
	return s
}
func responseOut(r api.Response) object {
	v := obj(r.Wire)
	v["role"] = "assistant"
	v["content"] = contentOut(r.Content)
	v["stop"] = stopOut(r.Stop)
	usage := asObject(v["usage"])
	usage["input"], usage["output"], usage["cacheRead"], usage["cacheWrite"], usage["cost"] = r.Usage.Input, r.Usage.Output, r.Usage.Cached, r.Usage.CacheWrite, r.Usage.Cost
	v["usage"] = usage
	return v
}
func responseIn(v object) api.Response {
	u := asObject(v["usage"])
	cost := real(u, "cost")
	return api.Response{Content: contentIn(v["content"]), Stop: stopIn(str(v, "stop")), Usage: api.Usage{Input: number(u, "input"), Output: number(u, "output"), Cached: number(u, "cacheRead"), CacheWrite: number(u, "cacheWrite"), Cost: cost}, Wire: api.JSON(v)}
}
