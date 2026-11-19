package harness

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"strings"
)

// A recorded selection is never replaced by the default when resolving it fails.
// Settle the turn itself so its input is kept and keyed retries see the same failure.
func unavailableTurn(ctx context.Context, p *turnPorts, settings api.Settings, prepared api.BeforeTurn, tools []api.Tool, resume *api.Entry, cause error) api.Outcome {
	failure := &api.ModelError{Kind: "other", Message: cause.Error()}
	out := api.Outcome{Status: "failed", Error: failure.Error()}
	if cause == api.ErrTenantTokens {
		out.Status, out.Error = "limit", cause.Error()
	}
	if resume == nil {
		provider, _, qualified := strings.Cut(settings.Model, "/")
		if !qualified {
			provider = ""
		}
		p.model = api.Model{ID: settings.Model, Provider: provider}
		start := api.TurnStart{StartedBy: api.TurnStarter{Kind: "actor", ID: p.actor}, Model: p.model, Input: p.input.ID, Settings: settings, System: prepared.System, Context: prepared.Context, Tools: tools}
		if p.input.Job != "" {
			start.StartedBy = api.TurnStarter{Kind: "job", ID: p.input.Job}
		}
		if _, err := p.Record(ctx, api.Entry{Kind: "turn.start", Data: api.JSON(start)}); err != nil {
			out.Error = err.Error()
			return out
		}
		p.Emit(ctx, api.Event{Kind: "turn.start"})
	} else {
		snap, err := p.Snapshot()
		if err != nil {
			out.Error = err.Error()
			return out
		}
		for _, e := range snap.Entries {
			if e.Turn == p.id && e.Kind == "model" {
				out.Usage.Add(api.Decode[struct{ Usage api.Usage }](e.Data).Usage)
			}
		}
		started := map[string]bool{}
		fromTurn := map[string]bool{}
		for _, e := range snap.Branch() {
			if e.Turn != p.id {
				continue
			}
			if e.Kind == "model" {
				for _, part := range e.Content {
					if part.Call != nil {
						fromTurn[part.Call.ID] = true
					}
				}
			}
			if e.Kind == "tool.started" {
				started[e.Call], fromTurn[e.Call] = true, true
			}
		}
		for _, call := range api.OpenCalls(snap) {
			if !fromTurn[call.ID] {
				continue
			}
			result := api.ToolResult{Call: call.ID, Name: call.Name, Status: "not_started", Content: api.Text(out.Error)}
			if started[call.ID] {
				result.Status = "unknown"
				result.Content = api.Text("Interrupted call was not repeated; its outcome is unknown.")
			}
			if _, err := p.Record(ctx, api.Entry{Kind: "tool.result", Step: call.Step, Call: call.ID, Visible: true, Content: result.Content, Data: api.JSON(result)}); err != nil {
				out.Error = err.Error()
				return out
			}
		}
	}
	if _, err := p.Record(ctx, api.Entry{Kind: "turn.end", Data: api.JSON(out)}); err != nil {
		out.Error = err.Error()
		return out
	}
	_, _ = p.Hook(ctx, "runtime.turn.end", out)
	p.Emit(ctx, api.Event{Kind: "turn.end", Data: api.JSON(out)})
	return out
}
