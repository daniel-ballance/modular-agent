package portable

import (
	"bytes"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"
	"strings"
)

// ValidOutputEdit permits string redactions, never a change to a routing key,
// a non-string value, an array's order or the object's fields.
func ValidOutputEdit(before, after OutputEvent) bool {
	if before.Type != after.Type {
		return false
	}
	if bytes.Equal(before.Data, after.Data) {
		return true
	}
	parse := func(raw []byte) (any, error) {
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		var v any
		err := d.Decode(&v)
		return v, err
	}
	a, err := parse(before.Data)
	b, other := parse(after.Data)
	return err == nil && other == nil && editable(a, b)
}

func editable(a, b any) bool {
	switch x := a.(type) {
	case string:
		_, ok := b.(string)
		return ok
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(y) != len(x) {
			return false
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok {
				return false
			}
			switch {
			case k == "type", k == "kind", k == "status", k == "method", k == "stop", k == "id", strings.HasSuffix(k, "Id"), strings.HasSuffix(k, "Ids"):
				if !equalValue(v, w) {
					return false
				}
			default:
				if !editable(v, w) {
					return false
				}
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i, v := range x {
			if !editable(v, y[i]) {
				return false
			}
		}
		return true
	default:
		return equalValue(a, b)
	}
}

// GateSegmentBytes bounds the encoded events array, including commas and brackets.
const GateSegmentBytes = 4 << 20

type OutputEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func ProjectOutput(e api.Event) OutputEvent {
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
		kind, data = "toolCall", object{"call": Call(api.Decode[api.Call](e.Data))}
	case "tool.progress":
		kind, data = "toolOutput", ToolOutput(e.Call, e.Data)
	case "tool.end":
		r := api.Decode[api.ToolResult](e.Data)
		kind, data = "toolResult", object{"toolCallId": e.Call, "status": StatusOut(r.Status), "content": Content(r.Content)}
	case "history.added":
		kind, data = "entry", object{"entry": Entry(api.Decode[api.Entry](e.Data))}
	case "turn.end":
		o := api.Decode[api.Outcome](e.Data)
		kind, data = "turnEnded", object{"turnId": e.Turn, "outcome": OutcomeKind(o), "result": TurnResult(o)}
	case "interface.answer":
		kind, data = "reply", object{"method": e.Method, "result": e.Data}
	case "interface.request":
		kind, data = "request", object{"method": e.Method, "params": e.Data}
	}
	if kind == e.Kind && !strings.Contains(kind, ".") {
		kind = "go." + kind
	}
	return OutputEvent{kind, api.JSON(data)}
}

func OutcomeKind(o api.Outcome) object {
	v := object{"kind": o.Status}
	if o.Status == "limit" {
		v["limit"] = strings.TrimSuffix(o.Error, " limit")
	} else if o.Error != "" {
		v["error"] = o.Error
	}
	return v
}
func TurnResult(o api.Outcome) object {
	ids := []string{}
	for _, c := range o.Open {
		ids = append(ids, c.ID)
	}
	v := object{"openToolCalls": ids}
	if text := o.Result.Text(); text != "" {
		v["text"] = text
	}
	if len(o.Value) > 0 {
		v["value"] = o.Value
	}
	return v
}
