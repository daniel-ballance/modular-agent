package modular

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type Event interface{ Header() EventHeader }
type EventHeader struct {
	Type      string    `json:"type"`
	Time      time.Time `json:"time"`
	SessionID string    `json:"sessionId,omitempty"`
	TurnID    string    `json:"turnId,omitempty"`
	StepID    string    `json:"stepId,omitempty"`
	CallID    string    `json:"toolCallId,omitempty"`
	ActorID   string    `json:"actorId,omitempty"`
}

func (h EventHeader) Header() EventHeader { return h }

type TextEvent struct {
	EventHeader
	Delta string `json:"delta"`
}
type TurnResult struct {
	Text          string          `json:"text,omitempty"`
	Value         json.RawMessage `json:"value,omitempty"`
	OpenToolCalls []string        `json:"openToolCalls"`
}

type EndEvent struct {
	EventHeader
	Outcome Outcome
	Result  TurnResult
}

func (e TextEvent) MarshalJSON() ([]byte, error) {
	data := map[string]any{"delta": e.Delta}
	if e.StepID != "" {
		data["stepId"] = e.StepID
	}
	return json.Marshal(DataEvent{EventHeader: e.EventHeader, Data: api.JSON(data)})
}
func (e EndEvent) MarshalJSON() ([]byte, error) {
	data := map[string]any{"turnId": e.TurnID, "outcome": e.Outcome, "result": e.Result}
	return json.Marshal(DataEvent{EventHeader: e.EventHeader, Data: api.JSON(data)})
}

type DataEvent struct {
	EventHeader
	Data json.RawMessage `json:"data"`
}

// TypedEvent carries the SDK payload declared for a standard event. Raw preserves
// fields that a newer peer may add to the payload.
type TypedEvent[T any] struct {
	EventHeader
	Data T `json:"data"`
	raw  json.RawMessage
}

func (e TypedEvent[T]) Raw() DataEvent               { return DataEvent{EventHeader: e.EventHeader, Data: e.raw} }
func (e TypedEvent[T]) MarshalJSON() ([]byte, error) { return json.Marshal(e.Raw()) }
func (e DataEvent) Raw() DataEvent                   { return e }

func typedEvent[T any](h EventHeader, data json.RawMessage) Event {
	return TypedEvent[T]{EventHeader: h, Data: api.Decode[T](data), raw: data}
}

type PieceData struct {
	Delta      string `json:"delta"`
	ToolCallID string `json:"toolCallId,omitempty"`
}
type ToolCallData struct {
	Call ToolCall `json:"call"`
}
type ToolOutputData struct {
	ToolCallID string `json:"toolCallId"`
	Chunk      string `json:"chunk"`
}
type EntryData struct {
	Entry HistoryEntry `json:"entry"`
}
type ActorData struct {
	Actor     Actor  `json:"actor"`
	GrantedBy string `json:"grantedBy"`
}
type PositionData struct {
	EntryID string `json:"entryId"`
	Rewind  bool   `json:"rewind"`
}
type InputData struct {
	InputID string `json:"inputId"`
}
type SessionData struct {
	SessionID string `json:"sessionId"`
	Reopened  bool   `json:"reopened,omitempty"`
}
type JobData struct {
	ID     string
	Kind   string
	State  string
	Detail json.RawMessage
}
type JobProgressData struct {
	JobID   string  `json:"jobId"`
	Content Content `json:"content"`
}

var eventNames = map[string]string{
	"turn.start": "turnStarted", "turn.end": "turnEnded", "step.start": "stepStarted", "step.end": "stepEnded",
	"tool.requested": "toolCall", "tool.started": "toolStarted", "tool.progress": "toolOutput", "tool.end": "toolResult",
	"question.open": "questionOpened", "question.answered": "questionAnswered", "question.closed": "questionClosed",
	"session.join": "actorJoined", "session.leave": "actorLeft", "job.ended": "jobEnded", "job.started": "jobStarted",
	"session.ready": "sessionStarted", "session.end": "sessionEnded", "position.moved": "positionMoved", "entries.erased": "entriesErased", "setting.changed": "settingChanged", "input.accepted": "inputAccepted", "input.withdrawn": "inputWithdrawn", "question.unanswerable": "questionNoLongerAnswerable",
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
		piece := map[string]any{"delta": p.Text}
		if id := api.Decode[struct{ ToolCallID string }](p.Wire).ToolCallID; id != "" {
			piece["toolCallId"] = id
		}
		if e.Step != "" {
			piece["stepId"] = e.Step
		}
		data = api.JSON(piece)
	case "turn.end":
		out := api.Decode[api.Outcome](e.Data)
		open := make([]string, 0, len(out.Open))
		for _, c := range out.Open {
			open = append(open, c.ID)
		}
		return EndEvent{EventHeader: h, Outcome: *outcome(out), Result: TurnResult{Text: out.Result.Text(), Value: out.Value, OpenToolCalls: open}}
	case "history.added":
		data = api.JSON(map[string]any{"entry": portable.Entry(api.Decode[api.Entry](e.Data))})
	case "tool.requested", "tool.started":
		data = api.JSON(map[string]any{"call": portable.Call(api.Decode[api.Call](e.Data))})
	case "tool.end":
		result := api.Decode[api.ToolResult](e.Data)
		data = api.JSON(map[string]any{"toolCallId": result.Call, "status": portable.StatusOut(result.Status), "content": portable.Content(result.Content)})
	case "tool.progress":
		var content api.Content
		if json.Unmarshal(e.Data, &content) != nil {
			content = api.Text(api.Decode[string](e.Data))
		}
		data = api.JSON(map[string]any{"toolCallId": e.Call, "chunk": content.Text()})
	}
	if h.Type == "" {
		if !strings.HasPrefix(e.Kind, "plugin.") {
			return nil
		}
		h.Type = e.Kind
	}
	switch h.Type {
	case "reasoning", "toolInput", "audio":
		return typedEvent[PieceData](h, data)
	case "entry":
		return typedEvent[EntryData](h, data)
	case "toolCall", "toolStarted":
		return typedEvent[ToolCallData](h, data)
	case "toolOutput":
		return typedEvent[ToolOutputData](h, data)
	case "toolResult":
		return typedEvent[ToolResult](h, data)
	case "sessionStarted", "sessionEnded":
		return typedEvent[SessionData](h, data)
	case "actorJoined", "actorLeft":
		return typedEvent[ActorData](h, data)
	case "jobStarted", "jobEnded":
		return typedEvent[JobData](h, data)
	case "jobProgress":
		return typedEvent[JobProgressData](h, data)
	case "positionMoved":
		return typedEvent[PositionData](h, data)
	case "entriesErased":
		return typedEvent[ErasureReport](h, data)
	case "inputAccepted":
		return typedEvent[InputReceipt](h, data)
	case "inputWithdrawn":
		return typedEvent[InputData](h, data)
	}
	return DataEvent{EventHeader: h, Data: data}
}
