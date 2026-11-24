package portable

import (
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"
)

// PublicContent removes opaque reasoning data without changing readable text or unknown parts.
func PublicContent(content api.Content) api.Content {
	if content == nil {
		return nil
	}
	out := make(api.Content, 0, len(content))
	for _, p := range content {
		if p.Type == "reasoning" {
			if p.Text == "" {
				continue
			}
			p.Data = nil
			p.Wire = publicMessage(p.Wire)
		}
		out = append(out, p)
	}
	return out
}

func publicMessage(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	v := obj(raw)
	delete(v, "providerData")
	if content, ok := v["content"]; ok {
		v["content"] = contentOut(PublicContent(contentIn(content)))
	}
	return api.JSON(v)
}

// PublicMessage projects a message for a receiver other than its source Provider.
func PublicMessage(m api.Message) api.Message {
	m.Content = PublicContent(m.Content)
	m.Wire = publicMessage(m.Wire)
	return m
}

func cleanResult(outcome object) {
	if result, ok := outcome["result"]; ok {
		var content api.Content
		if json.Unmarshal(api.JSON(result), &content) == nil {
			outcome["result"] = PublicContent(content)
		}
	}
}

// PublicEntry projects a raw entry for Interface recipients, not for storage.
func PublicEntry(e api.Entry) api.Entry {
	if e.Kind == "question.answer" {
		e = WithoutApprovalView(e)
	}
	if e.Kind == api.InterfaceHandoffKind {
		e.Data, e.Wire = nil, nil
	}
	e.Content = PublicContent(e.Content)
	if e.Kind == "model" {
		d := obj(e.Data)
		for _, key := range []string{"Wire", "wire"} {
			if wire, ok := d[key]; ok {
				d[key] = publicMessage(api.JSON(wire))
			}
		}
		e.Data = api.JSON(d)
		if len(e.Wire) != 0 {
			v := obj(e.Wire)
			if msg, ok := v["message"]; ok {
				v["message"] = publicMessage(api.JSON(msg))
			}
			e.Wire = api.JSON(v)
		}
	} else if e.Kind == "turn.end" || e.Kind == "step.end" {
		if len(e.Data) != 0 {
			d := obj(e.Data)
			if e.Kind == "turn.end" {
				cleanResult(d)
			} else if outcome, ok := d["Outcome"]; ok {
				o := asObject(outcome)
				cleanResult(o)
				d["Outcome"] = o
			}
			e.Data = api.JSON(d)
		}
		if len(e.Wire) != 0 {
			v := obj(e.Wire)
			d := asObject(v["data"])
			if content, ok := d["go.resultContent"]; ok {
				d["go.resultContent"] = contentOut(PublicContent(contentIn(content)))
				v["data"] = d
				e.Wire = api.JSON(v)
			}
		}
	} else if e.Kind == "model.request" && len(e.Wire) != 0 {
		v := obj(e.Wire)
		d := asObject(v["data"])
		if request, ok := d["request"]; ok {
			r := asObject(request)
			var messages []json.RawMessage
			if json.Unmarshal(api.JSON(r["messages"]), &messages) == nil {
				for i := range messages {
					messages[i] = publicMessage(messages[i])
				}
				r["messages"] = messages
			}
			d["request"] = r
			v["data"] = d
			e.Wire = api.JSON(v)
		}
	}
	return e
}
