package pluginrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type outputEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func outputOut(e api.Event) outputEvent {
	kind := e.Kind
	var data any = e.Data
	switch kind {
	case "model.delta":
		part := api.Decode[api.Part](e.Data)
		if part.Type == "text" || part.Type == "reasoning" {
			kind = part.Type
			d := object{"delta": part.Text}
			if e.Step != "" {
				d["stepId"] = e.Step
			}
			data = d
		}
	case "tool.requested":
		kind, data = "toolCall", object{"call": portable.Call(api.Decode[api.Call](e.Data))}
	case "tool.progress":
		kind, data = "toolOutput", portable.ToolOutput(e.Call, e.Data)
	case "tool.end":
		r := api.Decode[api.ToolResult](e.Data)
		kind, data = "toolResult", object{"toolCallId": e.Call, "status": portable.StatusOut(r.Status), "content": portable.Content(r.Content)}
	case "history.added":
		kind, data = "entry", object{"entry": portable.Entry(api.Decode[api.Entry](e.Data))}
	case "turn.end":
		o := api.Decode[api.Outcome](e.Data)
		kind, data = "turnEnded", object{"turnId": e.Turn, "outcome": outcomeKindOut(o), "result": turnResultOut(o)}
	case "interface.answer":
		kind, data = "reply", object{"method": e.Method, "result": e.Data}
	case "interface.request":
		kind, data = "request", object{"method": e.Method, "params": e.Data}
	}
	if kind == e.Kind && !strings.Contains(kind, ".") {
		kind = "go." + kind
	}
	return outputEvent{kind, mustJSON(data)}
}

func canonicalOutput(raw json.RawMessage) []byte {
	var v any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&v) != nil {
		return raw
	}
	return mustJSON(v)
}

func parseOutput(raw json.RawMessage) object {
	var v object
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	_ = d.Decode(&v)
	return v
}

func outputIn(e api.Event, v outputEvent) (api.Event, error) {
	invalid := fault("invalid_request", "cannot map changed output event")
	original := outputOut(e)
	if v.Type != original.Type || len(v.Data) == 0 {
		return e, invalid
	}
	if bytes.Equal(canonicalOutput(v.Data), canonicalOutput(original.Data)) {
		return e, nil
	}
	d := parseOutput(v.Data)
	switch v.Type {
	case "text", "reasoning":
		delta, ok := d["delta"].(string)
		if !ok || str(d, "stepId") != e.Step {
			return e, invalid
		}
		e.Data = mustJSON(api.Part{Type: v.Type, Text: delta})
	case "toolCall":
		c := portable.ReadCall(asObject(d["call"]))
		if c.ID != e.Call || c.Name == "" {
			return e, invalid
		}
		e.Data = mustJSON(c)
	case "toolOutput":
		chunk, ok := d["chunk"].(string)
		if !ok || str(d, "toolCallId") != e.Call {
			return e, invalid
		}
		e.Data = mustJSON(chunk)
		if raw, exists := d["content"]; exists {
			parts, ok := raw.([]any)
			if !ok {
				return e, invalid
			}
			content := portable.ReadContent(parts)
			// A gate that knows only chunk may redact it and echo the
			// optional content unchanged. Never expose the old text.
			if content.Text() == chunk {
				e.Data = mustJSON(content)
			}
		}
	case "toolResult":
		r := api.Decode[api.ToolResult](e.Data)
		content, ok := d["content"].([]any)
		if !ok || str(d, "toolCallId") != e.Call || str(d, "status") == "" {
			return e, invalid
		}
		r.Status, r.Content = portable.StatusIn(str(d, "status")), portable.ReadContent(content)
		e.Data = mustJSON(r)
	case "entry":
		entry, err := portable.ReadEntry(mustJSON(d["entry"]))
		if err != nil || entry.ID != api.Decode[api.Entry](e.Data).ID {
			return e, invalid
		}
		e.Data = mustJSON(entry)
	case "turnEnded":
		orig := api.Decode[api.Outcome](e.Data)
		result := asObject(d["result"])
		o := outcomeIn(d)
		if str(d, "turnId") != e.Turn || o.Status == "" || result == nil {
			return e, invalid
		}
		for i, call := range o.Open {
			for _, original := range orig.Open {
				if call.ID == original.ID {
					o.Open[i] = original
					break
				}
			}
		}
		o.Usage, o.Returned = orig.Usage, orig.Returned
		e.Data = mustJSON(o)
	case "request":
		if _, ok := d["params"]; str(d, "method") != e.Method || !ok {
			return e, invalid
		}
		e.Data = mustJSON(d["params"])
	case "reply":
		if _, ok := d["result"]; str(d, "method") != e.Method || !ok {
			return e, invalid
		}
		e.Data = mustJSON(d["result"])
	default:
		e.Data = v.Data
	}
	return e, nil
}

func (r *remote) outputHandler(ctx context.Context, id int, batch api.OutputBatch) (api.Decision, error) {
	r.inOutput.Add(1)
	defer r.inOutput.Add(-1)
	return handleOutput(ctx, batch, func(ctx context.Context, payload Object, out any) error {
		return r.call(withWork(ctx, work{session: batch.Session}), "hook/handle", object{"handlerId": id, "hook": "output", "payload": payload}, out)
	})
}

func handleOutput(ctx context.Context, batch api.OutputBatch, invoke func(context.Context, Object, any) error) (api.Decision, error) {
	events := make([]outputEvent, 0, len(batch.Events))
	byKind := map[string][]api.Event{}
	for _, e := range batch.Events {
		v := outputOut(e)
		events = append(events, v)
		byKind[v.Type] = append(byKind[v.Type], e)
	}
	var result *struct {
		Block  bool           `json:"block"`
		Events *[]outputEvent `json:"events"`
	}
	payload := object{"sessionId": batch.Session, "recipient": batch.Recipient, "events": events, "final": true}
	if err := invoke(ctx, payload, &result); err != nil {
		return api.Decision{}, err
	}
	if result == nil {
		return api.Decision{}, nil
	}
	if result.Block {
		return api.Decision{Refuse: true}, nil
	}
	if result.Events == nil {
		return api.Decision{}, fault("invalid_request", "output handler must return events or block")
	}
	batch.Events = nil
	for _, v := range *result.Events {
		orig := byKind[v.Type]
		if len(orig) == 0 {
			return api.Decision{}, fault("invalid_request", "cannot map changed output event")
		}
		e, err := outputIn(orig[0], v)
		if err != nil {
			return api.Decision{}, err
		}
		byKind[v.Type] = orig[1:]
		batch.Events = append(batch.Events, e)
	}
	return api.Decision{Value: batch}, nil
}

func redactOutput(_ context.Context, hook string, payload object) (any, error) {
	if hook != "output" {
		return nil, fault("unknown_handler", "wrong hook")
	}
	const secret, replacement = "conformance-secret", "[redacted]"
	events, ok := payload["events"].([]any)
	if !ok {
		return nil, fault("invalid_request", "output events are required")
	}
	// A reasoning event can interrupt text without breaking the text stream.
	// Group only the known stream types, not arbitrary events with a delta.
	type channel struct{ kind, id, field string }
	groups := map[channel][]object{}
	for _, event := range events {
		e, _ := event.(map[string]any)
		d, _ := e["data"].(map[string]any)
		var ch channel
		switch kind := str(e, "type"); kind {
		case "text", "reasoning":
			ch = channel{kind, str(d, "stepId"), "delta"}
		case "toolOutput":
			ch = channel{kind, str(d, "toolCallId"), "chunk"}
		default:
			continue
		}
		if _, ok := d[ch.field].(string); ok {
			groups[ch] = append(groups[ch], d)
		}
	}
	for ch, chunks := range groups {
		var joined strings.Builder
		var ends []int
		for _, d := range chunks {
			joined.WriteString(str(d, ch.field))
			ends = append(ends, joined.Len())
		}
		s := joined.String()
		if strings.Contains(s, secret) {
			var pos int
			for k, end := range ends {
				var out strings.Builder
				for pos < end {
					if strings.HasPrefix(s[pos:], secret) {
						out.WriteString(replacement)
						pos += len(secret)
					} else {
						out.WriteByte(s[pos])
						pos++
					}
				}
				chunks[k][ch.field] = out.String()
			}
		}
	}
	var redact func(any) any
	redact = func(v any) any {
		switch x := v.(type) {
		case string:
			return strings.ReplaceAll(x, secret, replacement)
		case []any:
			for i, item := range x {
				x[i] = redact(item)
			}
		case map[string]any:
			for key, item := range x {
				x[key] = redact(item)
			}
		}
		return v
	}
	return object{"events": redact(events)}, nil
}
