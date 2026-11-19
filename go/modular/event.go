package modular

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

type Event interface{ Header() EventHeader }
type EventHeader struct {
	Type      string    `json:"type"`
	Time      time.Time `json:"time"`
	SessionID string    `json:"sessionId,omitempty"`
	TurnID    string    `json:"turnId,omitempty"`
	StepID    string    `json:"stepId,omitempty"`
	CallID    string    `json:"callId,omitempty"`
	ActorID   string    `json:"actorId,omitempty"`
}

func (h EventHeader) Header() EventHeader { return h }

type TextEvent struct {
	EventHeader
	Delta string `json:"delta"`
}
type EndEvent struct {
	EventHeader
	Outcome Outcome `json:"outcome"`
}
type DataEvent struct {
	EventHeader
	Data json.RawMessage `json:"data"`
}

var eventNames = map[string]string{
	"turn.start": "turnStarted", "turn.end": "turnEnded", "step.start": "stepStarted", "step.end": "stepEnded",
	"tool.requested": "toolCall", "tool.started": "toolStarted", "tool.progress": "toolOutput", "tool.end": "toolResult",
	"question.open": "questionOpened", "question.answered": "questionAnswered", "question.closed": "questionClosed",
	"input.returned": "inputHandedBack", "history.added": "entry", "job.start": "jobStarted", "job.end": "jobEnded", "job.progress": "jobProgress",
}

func sdkEvent(e api.Event) Event {
	h := EventHeader{Type: eventNames[e.Kind], Time: e.Time, SessionID: e.Session, TurnID: e.Turn, StepID: e.Step, CallID: e.Call, ActorID: e.Actor}
	data := e.Data
	switch e.Kind {
	case "model.delta":
		p := api.Decode[api.Part](e.Data)
		h.Type = p.Type
		if p.Type == "text" {
			return TextEvent{EventHeader: h, Delta: p.Text}
		}
		data = api.JSON(map[string]any{"delta": p.Text})
	case "turn.end":
		out := api.Decode[api.Outcome](e.Data)
		return EndEvent{EventHeader: h, Outcome: Outcome{Kind: out.Status, Error: out.Error}}
	case "history.added":
		data = api.JSON(portable.Entry(api.Decode[api.Entry](e.Data)))
	case "tool.requested":
		data = api.JSON(portable.Call(api.Decode[api.Call](e.Data)))
	case "tool.end":
		data = api.JSON(portable.Result(api.Decode[api.ToolResult](e.Data)))
	}
	if h.Type == "" {
		if !strings.HasPrefix(e.Kind, "plugin.") {
			return nil
		}
		h.Type = e.Kind
	}
	return DataEvent{EventHeader: h, Data: data}
}
