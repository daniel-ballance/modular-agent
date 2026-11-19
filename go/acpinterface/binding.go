package acpinterface

import (
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
	"strings"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func (s *server) declaration(id string) map[string]any { return Declaration(s.a, s.project, id) }

// Declaration is shared by the ACP and stdio plugin bindings.
func Declaration(a api.API, project, id string) map[string]any {
	runtime := api.RuntimeDeclaration{}
	if v, err := a.Get("runtime"); err == nil {
		runtime = v.(api.Runtime).Declaration()
	}
	holds, strong, rewind := false, false, false
	if v, err := a.Get("output-policy"); err == nil {
		holds = v.(bool)
	}
	if v, err := a.Get("working-environment"); err == nil {
		env := v.(api.WorkingEnvironment)
		strong = env.StopsOnCrash()
		_, rewind = api.Points(env)
	}
	if output, ok := a.(interface{ HoldsOutput() bool }); ok {
		holds = holds || output.HoldsOutput()
	}
	stateful, tools := false, false
	if snap, err := a.Snapshot(id); err == nil {
		for _, v := range a.All("provider.") {
			for _, m := range v.(api.Provider).Catalog() {
				if modelMatches(m, snap.Settings.Model) {
					stateful, tools = m.Stateful, m.RunsTools
				}
			}
		}
	}
	containment := "none"
	if strong {
		containment = "strong"
	}
	if v, err := a.Get("working-environment"); err == nil {
		if e, ok := v.(interface{ Containment() string }); ok {
			containment = e.Containment()
		}
	}
	return map[string]any{
		"projectRoot":     project,
		"inputDuringTurn": runtime.Steering, "waitingThroughRestart": runtime.WaitingThroughRestart,
		"continuesAfterRestart": runtime.Durable, "rewinding": rewind, "forking": true,
		"keepsStateAtProvider": stateful, "runsToolsAtProvider": tools, "liveSessions": false,
		"sessionLimits": true, "tenants": true, "severalActors": true, "holdsOutput": holds, "outputBypassesAgent": false,
		"cancellingTurnCancelsJobs": false, "pluginsDuringSession": false, "erasure": true,
		"portableSessions": true, "inputKeys": true, "questionsOutlastTurns": true, "lateAnswersStartTurns": true, "startsTurnsUnasked": "jobReports",
		"queuedInputAfterRestart": "run", "movingWithUnfinishedWork": "refused",
		"mixedActorInput": "refused", "settingsDuringTurn": "nextTurn", "erasureDuringTurn": "refused",
		"commandContainment": containment,
	}
}
func modelValue(m api.Model) string {
	if strings.Contains(m.ID, "/") {
		return m.ID
	}
	return m.Provider + "/" + m.ID
}
func modelMatches(m api.Model, selection string) bool {
	return m.ID == selection || modelValue(m) == selection
}

func approvalValue(internal string) string {
	if internal == "" {
		return "off"
	}
	return api.ApprovalWire(api.ReopenedApproval(internal))
}
func outcomeValue(out api.Outcome) map[string]any {
	value := map[string]any{"kind": out.Status}
	if out.Error != "" {
		if out.Status == "limit" {
			limit := strings.TrimSuffix(out.Error, " limit")
			if limit == "step" {
				limit = "steps"
			}
			value["limit"] = limit
		} else {
			value["error"] = out.Error
		}
	}
	return value
}
func promptResponse(receipt api.Receipt, out api.Outcome) acp.PromptResponse {
	reason := acp.StopReasonEndTurn
	switch out.Status {
	case "cancelled":
		reason = acp.StopReasonCancelled
	case "failed":
		reason = acp.StopReasonRefusal
	case "limit":
		reason = acp.StopReasonMaxTurnRequests
		if out.Error == "output limit" || out.Error == api.ErrTenantTokens.Error() {
			reason = acp.StopReasonMaxTokens
		}
	}
	open := []string{}
	for _, call := range out.Open {
		open = append(open, call.ID)
	}
	meta := map[string]any{"inputId": receipt.ID, "outcome": outcomeValue(out)}
	if receipt.Duplicate {
		meta["duplicate"] = true
	}
	if len(open) > 0 {
		meta["openToolCalls"] = open
	}
	if receipt.When == "command" {
		delete(meta, "outcome")
		meta["disposition"] = "handled"
	}
	if out.Status == "cancelled" {
		returned := []map[string]any{}
		for _, in := range out.Returned {
			returned = append(returned, map[string]any{"inputId": in.ID, "content": contentBlocks(in.Content)})
		}
		meta["handedBack"] = returned
	}
	return acp.PromptResponse{StopReason: reason, Meta: map[string]json.RawMessage{Namespace: api.JSON(meta)}}
}
func contentBlocks(content api.Content) []any {
	out := []any{}
	for _, p := range content {
		if p.Type == "text" {
			out = append(out, map[string]any{"type": "text", "text": p.Text})
		} else if p.Type == "reasoning" {
			out = append(out, map[string]any{"type": "text", "text": p.Text, "_meta": map[string]any{Namespace: map[string]any{"reasoning": true}}})
		} else if p.Type == "tool_call" && p.Call != nil {
			out = append(out, map[string]any{"type": "toolCall", "id": p.Call.ID, "name": p.Call.Name, "arguments": p.Call.Input})
		} else {
			out = append(out, p)
		}
	}
	return out
}
func entryValue(e api.Entry) map[string]any {
	if (e.Kind == "erasure" && len(e.Data) == 0) || e.Kind == "turn.start" || e.Kind == "tool.started" || e.Kind == "model" {
		return portable.Entry(e)
	}
	var parent any
	if e.Parent != "" {
		parent = e.Parent
	}
	kind := e.Kind
	switch kind {
	case "tool.result":
		kind = "toolResult"
	case "turn.end":
		kind = "turnEnd"
	}
	out := map[string]any{"id": e.ID, "parentId": parent, "kind": kind, "time": e.Time.UnixMilli()}
	if e.Turn != "" {
		out["turnId"] = e.Turn
	}
	if e.Call != "" {
		out["toolCallId"] = e.Call
	}
	if e.Actor != "" {
		out["actorId"] = e.Actor
	}
	if len(e.Data) > 0 {
		out["data"] = e.Data
	}
	role := ""
	switch e.Kind {
	case "limit", "tenant", "actor.set", "actor.left", "input.accepted", "input.returned", "job.start", "job.end", "job.cleanup", "model.request", "question.open", "question.answer", "plugins.set", "resultFeedback":
		return portable.Entry(e)
	case "input":
		role = "user"
		shared := portable.Entry(e)
		out["data"] = shared["data"]
		out["inputId"] = shared["inputId"]
		if e.Job != "" {
			out["jobId"] = e.Job
		}
	case "tool.result":
		r := api.Decode[api.ToolResult](e.Data)
		status := r.Status
		switch status {
		case "unknown":
			status = "outcomeUnknown"
		case "not_started":
			status = "notStarted"
		}
		out["data"] = map[string]any{"status": status}
		out["message"] = map[string]any{"role": "toolResult", "toolCallId": e.Call, "toolName": r.Name, "content": contentBlocks(e.Content), "isError": r.Status != "completed"}
	case "turn.end":
		o := api.Decode[api.Outcome](e.Data)
		open := []string{}
		for _, c := range o.Open {
			open = append(open, c.ID)
		}
		result := map[string]any{"text": o.Result.Text(), "openToolCalls": open}
		if len(o.Value) > 0 {
			result["value"] = o.Value
		}
		out["data"] = map[string]any{"outcome": outcomeValue(o), "result": result}
	}
	if role != "" {
		out["message"] = map[string]any{"role": role, "content": contentBlocks(e.Content)}
	}
	return out
}
func requestValue(q api.Question) map[string]any {
	out := map[string]any{"id": q.ID, "kind": q.Kind, "question": q.Prompt}
	if q.Kind == "choice" {
		out["options"] = q.Options
	}
	if q.Call != "" {
		out["toolCallId"] = q.Call
	}
	return out
}
