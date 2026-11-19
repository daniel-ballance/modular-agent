package modular

import (
	"encoding/json"
	"strings"
)

type Content []Part

// Part keeps the complete shared representation, including future part kinds.
type Part struct {
	Type   string                     `json:"type"`
	Text   string                     `json:"text,omitempty"`
	Fields map[string]json.RawMessage `json:"-"`
}

func (p *Part) UnmarshalJSON(b []byte) error {
	type known Part
	var k known
	if err := json.Unmarshal(b, &k); err != nil {
		return err
	}
	*p = Part(k)
	return json.Unmarshal(b, &p.Fields)
}
func (p Part) MarshalJSON() ([]byte, error) {
	m := make(map[string]json.RawMessage, len(p.Fields)+2)
	for k, v := range p.Fields {
		m[k] = v
	}
	m["type"], _ = json.Marshal(p.Type)
	if p.Text != "" || p.Type == "text" {
		m["text"], _ = json.Marshal(p.Text)
	}
	return json.Marshal(m)
}
func Text(s string) Content { return Content{{Type: "text", Text: s}} }
func (c Content) Text() string {
	var b strings.Builder
	for _, p := range c {
		if p.Type == "text" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

type ModelRef struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

func (m ModelRef) String() string { return m.Provider + "/" + m.ID }

type Usage struct {
	Input      int     `json:"input"`
	Output     int     `json:"output"`
	CacheRead  int     `json:"cacheRead,omitempty"`
	CacheWrite int     `json:"cacheWrite,omitempty"`
	Cost       float64 `json:"cost,omitempty"`
}
type ToolStatus string

const (
	Completed      ToolStatus = "completed"
	Failed         ToolStatus = "failed"
	Refused        ToolStatus = "refused"
	Cancelled      ToolStatus = "cancelled"
	OutcomeUnknown ToolStatus = "outcomeUnknown"
	NotStarted     ToolStatus = "notStarted"
)

type ToolCall struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Input        json.RawMessage `json:"input"`
	StartedBy    string          `json:"startedBy,omitempty"`
	ActorID      string          `json:"actorId,omitempty"`
	ParentCallID string          `json:"parentCallId,omitempty"`
}
type ToolResult struct {
	CallID  string          `json:"callId"`
	Name    string          `json:"name"`
	Status  ToolStatus      `json:"status"`
	Content Content         `json:"content"`
	Value   json.RawMessage `json:"value,omitempty"`
}

func (r ToolResult) Text() string { return r.Content.Text() }

type HistoryEntry map[string]any
type Settings map[string]any
type Declaration map[string]any
