package harness

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
)

// Resolve child checkpoints before any Runtime sees the interrupted turn.
func (c *client) recoverNested(s *session) error {
	s.mu.Lock()
	entries := s.data.LiveEntries()
	s.mu.Unlock()
	children := map[string]api.Entry{}
	started := map[string]bool{}
	settled := map[string]bool{}
	for _, e := range entries {
		if e.WasKind("tool.result") {
			settled[e.Call] = true
		}
		if e.Kind == "tool.call" || e.Kind == "tool.started" {
			call := api.Decode[api.Call](e.Data)
			if call.ParentCall != "" || call.Origin == "tool" {
				children[e.Call] = e
				started[e.Call] = started[e.Call] || e.Kind == "tool.started"
			}
		}
	}
	for n := len(entries) - 1; n >= 0; n-- {
		e := entries[n]
		if children[e.Call].ID != e.ID || settled[e.Call] {
			continue
		}
		if q, err := c.Get("questions"); err == nil {
			if close, ok := q.(interface{ CloseCall(string, string) error }); ok {
				if err := close.CloseCall(s.id, e.Call); err != nil {
					return err
				}
			}
		}
		call := api.Decode[api.Call](e.Data)
		status, reason := "not_started", "Interrupted before nested dispatch."
		if started[e.Call] {
			status, reason = "unknown", "Nested execution interrupted; outcome unknown."
		}
		r := api.ToolResult{Call: e.Call, Name: call.Name, Status: status, Content: api.Text(reason)}
		if _, err := c.Record(context.Background(), s.id, api.Entry{Kind: "tool.result", Turn: e.Turn, Step: e.Step, Actor: e.Actor, Call: e.Call, Content: r.Content, Data: api.JSON(r), Copies: []string{e.ID}}); err != nil {
			return err
		}
	}
	return nil
}
