// Package portable translates history at storage and plugin boundaries. The
// in-process API is also used for events; it is not a persistence format.
package portable

import (
	"encoding/json"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"strings"
	"time"
)

var standard = map[string]string{
	"job.start": "jobStarted", "job.end": "jobEnded", "job.cleanup": "jobCleanupUnconfirmed",
	"input.accepted": "inputAccepted", "input.returned": "inputHandedBack", "model.request": "modelRequest", "plugins.set": "plugins",
	"tool.open": "toolPending", "limit": "limit", "tenant": "tenant", "input": "input", "turn.start": "turnStart", "model": "response", "tool.started": "toolStarted", "tool.result": "toolResult", "question.open": "inputRequest", "question.answer": "inputAnswer", "question.secret": "secretAnswerAccepted", "turn.end": "turnEnd", "summary": "summary", "setting": "setting", "actor.set": "actorJoined", "actor.left": "actorLeft", "position": "position", "erasure": "erasure", "resultFeedback": "resultFeedback",
}

func kindOut(kind string) string {
	if strings.HasPrefix(kind, "wire:") {
		return strings.TrimPrefix(kind, "wire:")
	}
	if k, ok := standard[kind]; ok {
		return k
	}
	if kind == "" || strings.Contains(kind, ".") {
		return kind
	}
	return "go." + kind
}
func kindIn(kind string) string {
	for k, v := range standard {
		if v == kind {
			return k
		}
	}
	// A wire extension must never acquire the meaning of a native work record.
	if _, collision := standard[kind]; collision || kind == "erased" || strings.HasPrefix(kind, "wire:") {
		return "wire:" + kind
	}
	return kind
}
func set(v object, k string, s any, present bool) {
	if present {
		v[k] = s
	} else {
		delete(v, k)
	}
}
func ref(model, provider string) object {
	if provider == "" {
		provider, _, _ = strings.Cut(model, "/")
		if !strings.Contains(model, "/") {
			provider = "go"
		}
	}
	return object{"provider": provider, "id": strings.TrimPrefix(model, provider+"/")}
}
func modelID(v object) string {
	p, id := str(v, "provider"), str(v, "id")
	if id == "" || p == "" || p == "go" {
		return id
	}
	return p + "/" + id
}
func usageOut(u api.Usage) object {
	return object{"input": u.Input, "output": u.Output, "cacheRead": u.Cached, "cacheWrite": u.CacheWrite, "cost": u.Cost}
}
func usageIn(o object) api.Usage {
	return api.Usage{Input: number(o, "input"), Output: number(o, "output"), Cached: number(o, "cacheRead"), CacheWrite: number(o, "cacheWrite"), Cost: real(o, "cost")}
}
func settingsOut(s api.Settings) object {
	v := object{}
	set(v, "reasoning", s.Thinking, s.Thinking != "")
	set(v, "maxSteps", s.MaxSteps, s.MaxSteps > 0)
	set(v, "maxOutput", s.MaxOutput, s.MaxOutput > 0)
	set(v, "model", ref(s.Model, ""), s.Model != "")
	set(v, "approvalWait", s.ApprovalWait, s.ApprovalWait != "")
	set(v, "approval", api.ApprovalWire(s.Approval), s.Approval != "")
	set(v, "modelTools", s.ModelTools, s.ModelTools != nil)
	set(v, "go.contextLimit", s.ContextLimit, s.ContextLimit != 0)
	return v
}
func applySettings(s *api.Settings, v object) {
	for k, x := range v {
		switch k {
		case "model":
			s.Model = modelID(asObject(x))
		case "reasoning":
			s.Thinking, _ = x.(string)
		case "maxSteps":
			s.MaxSteps = number(v, k)
		case "maxOutput":
			s.MaxOutput = number(v, k)
		case "approvalWait":
			s.ApprovalWait = str(v, k)
		case "approval":
			policy, _ := x.(string)
			if policy == "" {
				policy = "never"
			}
			s.Approval = api.ReopenedApproval(policy)
		case "modelTools":
			if x == nil {
				s.ModelTools = nil
			} else {
				var names []string
				if json.Unmarshal(api.JSON(x), &names) == nil {
					s.ModelTools = &names
				}
			}
		case "go.contextLimit":
			s.ContextLimit = number(v, k)
		}
	}
}

type responseData struct {
	Stop  string
	Usage api.Usage
	Wire  json.RawMessage
}
type summaryData struct {
	Covered []string
	Usage   api.Usage
}
type storedQuestion struct {
	Question                       api.Question
	ForwardSession, ForwardRequest string
}

// Entry encodes the shared entry shape, keeping unrecognized fields from other
// writers. Local-only fields use a namespace and never replace a standard key.
// EntryWithoutTrace keeps private trace records in the topology but does not
// disclose their data to ACP or a plugin.
func EntryWithoutTrace(e api.Entry) map[string]any {
	v := Entry(WithoutApprovalView(e))
	switch e.Kind {
	case telemetry.TurnTrace, api.InterfaceHandoffKind:
		delete(v, "data")
	case "turn.start":
		delete(asObject(v["data"]), "traceContext")
	}
	return v
}

func Entry(e api.Entry) map[string]any {
	v := obj(e.Wire)
	var parent any
	if e.Parent != "" {
		parent = e.Parent
	}
	if (e.Kind == "erasure" || e.Kind == "erased") && len(e.Data) == 0 {
		var kind any
		if e.OriginalKind != "" {
			kind = e.OriginalKind
			if canonical, known := standard[e.OriginalKind]; known {
				kind = canonical
			} else if strings.HasPrefix(e.OriginalKind, "wire:") {
				kind = kindOut(e.OriginalKind)
			}
		}
		v := object{"id": e.ID, "parentId": parent, "kind": kind, "erased": true}
		for k, id := range map[string]string{"turnId": e.Turn, "stepId": e.Step, "toolCallId": e.Call, "jobId": e.Job} {
			if id != "" {
				v[k] = id
			}
		}
		set(v, "sources", e.Copies, len(e.Copies) != 0)
		set(v, "inputId", e.InputRef, e.InputRef != "")
		set(v, "requestId", e.RequestRef, e.RequestRef != "")
		set(v, "continuesTurnId", e.ContinuesTurn, e.ContinuesTurn != "")
		set(v, "writer", e.Writer, e.JobKey != "" && e.Writer != "")
		set(v, "jobKey", e.JobKey, e.JobKey != "")
		return v
	}
	v["id"], v["parentId"], v["kind"], v["sessionId"], v["time"], v["writer"], v["modelVisible"] = e.ID, parent, kindOut(e.Kind), e.Session, e.Time.UnixMilli(), e.Writer, e.Visible
	for k, x := range map[string]string{"turnId": e.Turn, "stepId": e.Step, "toolCallId": e.Call, "actorId": e.Actor, "jobId": e.Job} {
		set(v, k, x, x != "")
	}
	set(v, "sources", e.Copies, len(e.Copies) > 0)
	d := asObject(v["data"])
	msg := asObject(v["message"])
	switch e.Kind {
	case "tenant":
		d["tenant"] = api.Decode[string](e.Data)
	case "limit":
		d["rights"] = api.Decode[[]string](e.Data)
	case "input.accepted":
		in := api.Decode[api.Input](e.Data)
		if e.Actor == "" && in.Actor != "" {
			v["actorId"] = in.Actor
		}
		set(v, "inputId", in.ID, in.ID != "")
		delete(d, "inputId")
		d["when"], d["content"] = in.When, contentOut(in.Content)
		set(d, "taken", in.Taken, in.Taken != "")
		set(d, "go.resultSchema", in.ResultSchema, len(in.ResultSchema) != 0)
		set(d, "parked", in.Parked, in.Parked != nil)
		if len(e.Wire) == 0 {
			rights := in.ConnectionRights
			authorizers := []object{}
			actors := []string{in.Actor, in.ViaActor, in.ReleasedBy}
			if in.Job != "" {
				authorizers = append(authorizers, object{"sessionId": e.Session, "jobId": in.Job})
				actors = actors[1:]
				rights = api.IntersectConnectionRights(rights, &in.JobRights)
			}
			seen := map[string]bool{}
			for _, actor := range actors {
				if actor != "" && !seen[actor] {
					authorizers = append(authorizers, object{"sessionId": e.Session, "actorId": actor})
					seen[actor] = true
				}
			}
			d["authorizers"] = authorizers
			set(d, "rights", rights, rights != nil)
		}
		set(d, "key", in.Key, in.Key != "")
		set(d, "releasedBy", in.ReleasedBy, in.ReleasedBy != "")
		set(d, "submittedBy", in.ViaActor, in.ViaActor != "")
		set(d, "go.answer", in.Answer, in.Answer != "")
		set(d, "go.calls", in.Calls, len(in.Calls) > 0)
	case "input.returned":
		v["inputId"] = e.InputRef
		d["reason"] = api.Decode[string](e.Data)
	case "model.request":
		m := api.Decode[api.Model](e.Data)
		model := asObject(d["model"])
		for k, value := range ref(m.ID, m.Provider) {
			model[k] = value
		}
		d["model"] = model
		d["safeToRepeat"] = e.SafeToRepeat != nil && *e.SafeToRepeat
		if e.OfferedTools != nil {
			d["tools"] = *e.OfferedTools
		}
	case "plugins.set":
		if !has(d, "active") {
			active := []object{}
			for _, name := range api.Decode[[]string](e.Data) {
				active = append(active, object{"name": name})
			}
			d["active"] = active
		}
	case "input":
		msg["role"], msg["content"] = "user", contentOut(e.Content)
		set(v, "inputId", e.InputID(), e.InputID() != "")
		delete(d, "inputId")
		set(d, "key", e.InputKey, e.InputKey != "")
	case "turn.start":
		set(d, "point", e.Point, e.Point != "")
		s := api.Decode[api.TurnStart](e.Data)
		set(d, "traceContext", s.TraceContext, s.TraceContext != nil)
		set(v, "continuesTurnId", s.ContinuesTurn, s.ContinuesTurn != "")
		if s.StartedBy.Kind == "" {
			s.StartedBy = api.TurnStarter{Kind: "actor", ID: e.Actor}
		}
		tools := []object{}
		for _, t := range s.Tools {
			tools = append(tools, toolOut(t))
		}
		id, p := s.Model.ID, s.Model.Provider
		if id == "" {
			id = s.Settings.Model
		}
		d["startedBy"], d["model"], d["system"], d["tools"] = s.StartedBy, ref(id, p), s.System, tools
		settings := settingsOut(s.Settings)
		delete(settings, "model")
		for k, x := range asObject(d["settings"]) {
			if _, ok := settings[k]; !ok {
				settings[k] = x
			}
		}
		d["settings"] = settings
		set(d, "go.initialInput", s.Input, s.Input != "")
		delete(d, "go.context")
		set(d, "context", contentOut(s.Context), len(s.Context) > 0)
		if len(s.Calls) > 0 {
			calls := []object{}
			for _, c := range s.Calls {
				calls = append(calls, callOut(c))
			}
			d["go.continuedCalls"] = calls
		}
	case "model":
		r := api.Decode[responseData](e.Data)
		if r.Stop == "" {
			r.Stop = "finished"
		}
		msg = responseOut(api.Response{Content: e.Content, Stop: r.Stop, Usage: r.Usage, Wire: r.Wire})
		if boolean(d, "recovery") {
			delete(msg, "usage")
		}
	case "tool.open", api.InterfaceHandoffKind:
		d = asObject(e.Data)
	case "tool.started":
		set(d, "point", e.Point, e.Point != "")
		set(d, "go.outsideEnvironment", e.OutsideEnvironment, e.OutsideEnvironment)
		delete(d, "go.openWorld")
		set(d, "openWorld", e.OpenWorld, e.OpenWorld != nil)
		c := api.Decode[api.Call](e.Data)
		if c.Origin == "" {
			c.Origin = "model"
		}
		d["call"] = callOut(c)
		d["safeToRepeat"] = e.SafeToRepeat != nil && *e.SafeToRepeat
	case "tool.result":
		r := api.Decode[api.ToolResult](e.Data)
		name := r.Name
		if name == "" {
			name = str(msg, "toolName")
		}
		msg["role"], msg["toolCallId"], msg["toolName"], msg["content"], msg["isError"] = "toolResult", e.Call, name, contentOut(e.Content), r.Status != "completed"
		d["status"] = statusOut(r.Status)
		set(d, "value", r.Structured, len(r.Structured) > 0)
		set(d, "go.resultData", r.Data, len(r.Data) > 0)
		set(d, "go.resultWire", r.Wire, len(r.Wire) > 0)
		set(d, "go.reference", r.Reference, r.Reference != "")
		set(d, "go.resultSources", r.Copies, len(r.Copies) > 0)
	case "question.open":
		stored := api.Decode[storedQuestion](e.Data)
		q := stored.Question
		r := asObject(d["request"])
		r["id"], r["sessionId"], r["kind"], r["question"], r["answerable"] = q.ID, q.Session, q.Kind, q.Prompt, q.Answerable
		for k, x := range map[string]string{"toolCallId": q.Call, "key": q.Key, "credential": q.Credential, "go.actor": q.Actor, "go.forwardSession": stored.ForwardSession, "go.forwardRequest": stored.ForwardRequest} {
			set(r, k, x, x != "")
		}
		set(r, "coversNested", true, q.CoversNested)
		if q.ApprovalWait != "" {
			r["approvalWait"], r["whenTimeLimit"] = q.ApprovalWait, "decline"
			if q.Allowed != nil {
				r["answerers"] = q.Allowed
			}
		} else {
			set(r, "options", q.Options, len(q.Options) > 0)
		}
		set(r, "details", q.Details, len(q.Details) > 0)
		if q.ApprovalWait != "" {
			r["timeLimitMs"] = q.ApprovalIntervalMs
			if q.Deadline != nil {
				r["deadlineAt"] = q.Deadline.UnixMilli()
			}
		} else {
			set(r, "timeLimitMs", max(1, q.Wait.Milliseconds()), q.Wait > 0)
		}
		if q.Defer {
			r["whenTimeLimit"] = "leaveOpen"
		}
		set(r, "go.allowed", q.Allowed, len(q.Allowed) > 0)
		set(r, "go.path", q.Path, len(q.Path) > 0)
		set(r, "askedBy", q.Actor, q.Actor != "")
		if q.Wait > 0 {
			r["deadlineAt"] = e.Time.UnixMilli() + max(1, q.Wait.Milliseconds())
		}
		set(v, "requestId", q.ID, q.ID != "")
		if q.ApprovalCall != nil {
			d["call"] = callOut(*q.ApprovalCall)
		}
		if q.Definition != nil {
			if q.ApprovalWait != "" && len(q.Definition.Wire) != 0 {
				d["definition"] = q.Definition.Wire
			} else {
				d["definition"] = toolOut(*q.Definition)
			}
		}
		if q.Source != nil {
			d["source"] = q.Source
		}
		d["request"] = r
	case "question.secret":
		v["requestId"] = api.Decode[string](e.Data)
		delete(v, "data")
	case "question.answer":
		a := api.Decode[api.Answer](e.Data)
		set(v, "requestId", a.Request, a.Request != "")
		set(d, "approvalView", a.ApprovalView, a.ApprovalView != nil)
		set(d, "actorId", a.Actor, a.Actor != "")
		if a.Actor == "" {
			delete(v, "actorId")
		}
		set(d, "value", a.Value, !a.Declined && a.Stored == "")
		set(d, "declined", a.Declined, a.Declined)
		set(d, "reason", a.Reason, a.Reason != "")
		set(d, "cause", a.Cause, a.Cause == "revoked" && a.Actor == "" && (a.Reason == "refused" || a.Reason == "noLongerAnswerable"))
		set(d, "stored", a.Stored, a.Stored != "")
		set(d, "go.via", a.Via, len(a.Via) > 0)
	case "turn.end":
		o := api.Decode[api.Outcome](e.Data)
		outcome := asObject(d["outcome"])
		outcome["kind"] = o.Status
		if o.Status == "limit" {
			outcome["limit"] = strings.TrimSuffix(o.Error, " limit")
		} else {
			set(outcome, "error", o.Error, o.Error != "")
		}
		ids := []string{}
		for _, c := range o.Open {
			ids = append(ids, c.ID)
		}
		r := asObject(d["result"])
		r["openToolCalls"] = ids
		set(r, "text", o.Result.Text(), o.Result.Text() != "")
		set(r, "value", o.Value, len(o.Value) > 0)
		u := asObject(d["usage"])
		for k, x := range usageOut(o.Usage) {
			u[k] = x
		}
		d["outcome"], d["result"], d["usage"] = outcome, r, u
		set(d, "go.steps", o.Steps, o.Steps != 0)
		set(d, "go.resultContent", contentOut(o.Result), len(o.Result) > 0)
	case "summary":
		d["summary"] = e.Content.Text()
		s := api.Decode[summaryData](e.Data)
		if len(s.Covered) > 0 {
			v["sources"] = s.Covered
		}
		if s.Usage != (api.Usage{}) {
			d["go.usage"] = usageOut(s.Usage)
		}
	case "setting":
		if _, ok := d["key"]; !ok {
			settings := api.Decode[api.Settings](e.Data)
			values := settingsOut(settings)
			values["modelTools"] = settings.ModelTools
			d["key"], d["value"] = "settings", values
		}
	case "actor.set":
		a := asObject(d["actor"])
		actor := api.Decode[api.Actor](e.Data)
		a["id"], a["kind"], a["rights"] = actor.ID, actor.Kind, append([]string{}, actor.Rights...)
		d["actor"] = a
		if e.OperatorAdmission {
			d["operatorAdmission"] = true
		}
	case "actor.left":
		d["actorId"] = api.Decode[string](e.Data)
	case "job.start", "job.end":
		jobOut(e, d)
	case "position":
		p, _ := api.ReadPosition(e.Data)
		d["to"] = nil
		if p.To != nil {
			d["to"] = *p.To
		}
		set(d, "restore", p.Restore, p.Restore != nil)
	case "resultFeedback":
		d["reason"] = api.Decode[string](e.Data)
	case "erasure":
		r := api.ReadErasureRecord(e.Data)
		d["entryIds"] = r.EntryIDs
		set(d, "inputKeys", r.InputKeys, len(r.InputKeys) != 0)
	default:
		if len(e.Data) > 0 {
			v["data"] = e.Data
		}
		if len(e.Content) > 0 {
			v["go.content"] = contentOut(e.Content)
		}
		return v
	}
	if len(d) > 0 {
		v["data"] = d
	}
	if len(msg) > 0 {
		v["message"] = msg
	}
	return v
}

func ReadEntry(raw json.RawMessage) (api.Entry, error) {
	var v object
	if err := json.Unmarshal(raw, &v); err != nil {
		return api.Entry{}, err
	}
	e := api.Entry{Wire: raw, ID: str(v, "id"), Parent: str(v, "parentId"), Kind: kindIn(str(v, "kind")), Session: str(v, "sessionId"), Writer: str(v, "writer"), Visible: boolean(v, "modelVisible"), Turn: str(v, "turnId"), Step: str(v, "stepId"), Call: str(v, "toolCallId"), Actor: str(v, "actorId"), Job: str(v, "jobId"), Copies: api.Decode[[]string](api.JSON(v["sources"]))}
	if e.ID == "" {
		return e, fmt.Errorf("history entry has no identity")
	}
	if boolean(v, "erased") {
		e.InputRef, e.JobKey = str(v, "inputId"), str(v, "jobKey")
		e.RequestRef, e.ContinuesTurn = str(v, "requestId"), str(v, "continuesTurnId")
		return e.Redacted(), nil
	}
	ms, _ := json.Number(fmt.Sprint(v["time"])).Int64()
	e.Time = time.UnixMilli(ms).UTC()
	d, msg := asObject(v["data"]), asObject(v["message"])
	if e.Kind == "turn.start" || e.Kind == "tool.started" {
		e.Point = str(d, "point")
	}
	if e.Kind == "tool.started" {
		e.OutsideEnvironment = boolean(d, "go.outsideEnvironment")
		if b, ok := d["openWorld"].(bool); ok {
			e.OpenWorld = &b
		}
	}
	e.Content = contentIn(msg["content"])
	switch e.Kind {
	case "tenant":
		e.Data = api.JSON(d["tenant"])
	case "limit":
		e.Data = api.JSON(d["rights"])
	case "input.accepted":
		in := api.Input{ID: str(v, "inputId"), Key: str(d, "key"), Actor: e.Actor, When: str(d, "when"), ReleasedBy: str(d, "releasedBy"), ViaActor: str(d, "submittedBy"), Content: contentIn(d["content"]), Copies: e.Copies, Job: e.Job, Answer: str(d, "go.answer"), Calls: api.Decode[[]api.Call](api.JSON(d["go.calls"]))}
		if b, ok := d["parked"].(bool); ok {
			in.Parked = &b
		}
		in.Taken = str(d, "taken")
		if has(d, "go.resultSchema") {
			in.ResultSchema = api.JSON(d["go.resultSchema"])
		}
		if has(d, "go.connectionRights") || has(d, "go.viaActor") {
			return e, fmt.Errorf("admission %s has unsupported private authority fields", e.ID)
		}
		e.InputRef = in.ID
		if in.ID == "" {
			return e, fmt.Errorf("admission %s lacks inputId", e.ID)
		}
		if in.Job != "" {
			in.JobRights = api.Decode[[]string](api.JSON(d["rights"]))
		} else {
			in.ConnectionRights = api.Decode[*[]string](api.JSON(d["rights"]))
		}
		if in.Job != "" {
			in.Actor = api.JobActor(in.Job)
		}
		e.Data, e.Content = api.JSON(in), in.Content
	case "input.returned":
		e.InputRef, e.Data = str(v, "inputId"), api.JSON(str(d, "reason"))
		if e.InputRef == "" {
			return e, fmt.Errorf("hand-back %s lacks inputId", e.ID)
		}
	case "model.request":
		m := asObject(d["model"])
		e.Data = api.JSON(api.Model{ID: modelID(m), Provider: str(m, "provider")})
		b := boolean(d, "safeToRepeat")
		e.SafeToRepeat = &b
		if names := api.Decode[[]string](api.JSON(d["tools"])); names != nil {
			e.OfferedTools = &names
		}
	case "plugins.set":
		names := []string{}
		for _, plugin := range api.Decode[[]object](api.JSON(d["active"])) {
			names = append(names, str(plugin, "name"))
		}
		e.Data = api.JSON(names)
	case "input":
		e.InputRef = str(v, "inputId")
		e.InputKey = str(d, "key")
	case "turn.start":
		s := api.TurnStart{ContinuesTurn: str(v, "continuesTurnId"), StartedBy: api.Decode[api.TurnStarter](api.JSON(d["startedBy"])), System: str(d, "system"), Context: contentIn(d["context"]), Input: str(d, "go.initialInput")}
		s.TraceContext = api.Decode[*telemetry.Wire](api.JSON(d["traceContext"]))
		m := asObject(d["model"])
		s.Settings.Model = modelID(m)
		if _, ok := d["tools"].([]any); !ok {
			return e, fmt.Errorf("turn %s lacks its recorded tool offer", e.Turn)
		}
		if _, ok := d["settings"].(map[string]any); !ok {
			return e, fmt.Errorf("turn %s lacks its recorded settings", e.Turn)
		}
		if _, ok := d["system"].(string); !ok || s.StartedBy.Kind == "" || s.StartedBy.ID == "" {
			return e, fmt.Errorf("turn %s lacks its system or starter", e.Turn)
		}
		// Model identity doubles as the model setting for the running turn.
		s.Model = api.Model{ID: s.Settings.Model, Provider: str(m, "provider")}
		applySettings(&s.Settings, asObject(d["settings"]))
		s.Settings.Model = s.Model.ID
		for _, t := range api.Decode[[]object](api.JSON(d["tools"])) {
			s.Tools = append(s.Tools, toolIn(t))
		}
		for _, c := range api.Decode[[]object](api.JSON(d["go.continuedCalls"])) {
			s.Calls = append(s.Calls, callIn(c))
		}
		e.Data = api.JSON(s)
	case "model":
		r := responseIn(msg)
		e.Data = api.JSON(responseData{r.Stop, r.Usage, r.Wire})
	case "tool.open", api.InterfaceHandoffKind:
		e.Data = api.JSON(d)
	case "tool.started":
		c := callIn(asObject(d["call"]))
		e.Data = api.JSON(c)
		b := boolean(d, "safeToRepeat")
		e.SafeToRepeat = &b
	case "tool.result":
		r := api.ToolResult{Call: e.Call, Name: str(msg, "toolName"), Content: e.Content, Status: statusIn(str(d, "status")), Reference: str(d, "go.reference"), Copies: api.Decode[[]string](api.JSON(d["go.resultSources"]))}
		if has(d, "value") {
			r.Structured = api.JSON(d["value"])
		}
		if has(d, "go.resultData") {
			r.Data = api.JSON(d["go.resultData"])
		}
		if has(d, "go.resultWire") {
			r.Wire = api.JSON(d["go.resultWire"])
		}
		e.Data = api.JSON(r)
	case "question.open":
		r := asObject(d["request"])
		if str(v, "requestId") == "" || str(v, "requestId") != str(r, "id") {
			return e, fmt.Errorf("request %s lacks a matching requestId", e.ID)
		}
		q := api.Question{ID: str(v, "requestId"), Step: e.Step, Session: str(r, "sessionId"), Call: str(r, "toolCallId"), Actor: str(r, "go.actor"), Turn: e.Turn, Kind: str(r, "kind"), Prompt: str(r, "question"), Key: str(r, "key"), Credential: str(r, "credential"), Answerable: boolean(r, "answerable"), Wait: time.Duration(number(r, "timeLimitMs")) * time.Millisecond, Defer: str(r, "whenTimeLimit") == "leaveOpen"}
		if q.Session == "" {
			q.Session = e.Session
		}
		if q.Actor == "" {
			q.Actor = e.Actor
		}
		if q.Call == "" {
			q.Call = e.Call
		}
		if has(r, "details") {
			q.Details = api.JSON(r["details"])
		}
		q.Options = api.Decode[[]string](api.JSON(r["options"]))
		q.Allowed = api.Decode[[]string](api.JSON(r["go.allowed"]))
		q.CoversNested = boolean(r, "coversNested")
		q.ApprovalWait = str(r, "approvalWait")
		if q.ApprovalWait != "" {
			q.Wait = 0
			q.ApprovalIntervalMs = int64(number(r, "timeLimitMs"))
		}
		if has(r, "answerers") {
			q.Allowed = api.Decode[[]string](api.JSON(r["answerers"]))
		}
		if has(r, "deadlineAt") {
			t := time.UnixMilli(int64(number(r, "deadlineAt"))).UTC()
			q.Deadline = &t
		}
		q.Path = api.Decode[[]string](api.JSON(r["go.path"]))
		if call := asObject(d["call"]); len(call) != 0 {
			c := callIn(call)
			q.ApprovalCall = &c
		}
		if definition := asObject(d["definition"]); len(definition) != 0 {
			t := toolIn(definition)
			q.Definition = &t
		}
		if has(d, "source") {
			identity := api.Decode[api.ToolRegistration](api.JSON(d["source"]))
			q.Source = &identity
		}
		e.Data = api.JSON(storedQuestion{q, str(r, "go.forwardSession"), str(r, "go.forwardRequest")})
	case "question.secret":
		e.Data = api.JSON(str(v, "requestId"))
	case "question.answer":
		e.Data = api.JSON(api.Answer{ApprovalView: api.Decode[*api.ApprovalView](api.JSON(d["approvalView"])), Request: str(v, "requestId"), Actor: str(d, "actorId"), Value: str(d, "value"), Reason: str(d, "reason"), Cause: str(d, "cause"), Stored: str(d, "stored"), Declined: boolean(d, "declined"), Via: api.Decode[[]api.ActorRef](api.JSON(d["go.via"]))})
	case "turn.end":
		outcome, r := asObject(d["outcome"]), asObject(d["result"])
		o := api.Outcome{Status: str(outcome, "kind"), Error: str(outcome, "error"), Usage: usageIn(asObject(d["usage"])), Steps: number(d, "go.steps"), Copies: e.Copies}
		if o.Status == "limit" {
			o.Error = str(outcome, "limit") + " limit"
		}
		o.Result = contentIn(d["go.resultContent"])
		if len(o.Result) == 0 && str(r, "text") != "" {
			o.Result = api.Text(str(r, "text"))
		}
		if has(r, "value") {
			o.Value = api.JSON(r["value"])
		}
		for _, id := range api.Decode[[]string](api.JSON(r["openToolCalls"])) {
			o.Open = append(o.Open, api.Call{ID: id})
		}
		e.Data = api.JSON(o)
	case "summary":
		e.Content = api.Text(str(d, "summary"))
		e.Data = api.JSON(summaryData{e.Copies, usageIn(asObject(d["go.usage"]))})
	case "setting":
		var s api.Settings
		applySetting(&s, d)
		e.Data = api.JSON(s)
	case "actor.set":
		e.Data = api.JSON(d["actor"])
		e.OperatorAdmission = boolean(d, "operatorAdmission")
	case "actor.left":
		e.Data = api.JSON(str(d, "actorId"))
	case "job.start", "job.end":
		e.Data = api.JSON(jobIn(e, d))
	case "position":
		e.Data = api.JSON(v["data"])
		if _, err := api.ReadPosition(e.Data); err != nil {
			return e, err
		}
	case "resultFeedback":
		e.Data = api.JSON(d["reason"])
	case "erasure":
		e.Data = api.JSON(d)
	default:
		if has(v, "data") {
			e.Data = api.JSON(v["data"])
		}
		if has(v, "go.content") {
			e.Content = contentIn(v["go.content"])
		}
	}
	return e, nil
}
