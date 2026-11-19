package pluginrpc

import (
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"strings"
)

type RuntimeRegistration struct {
	ID       string          `json:"id"`
	Supports RuntimeSupports `json:"supports"`
}
type RuntimeSupports struct {
	InputDuringTurn       bool `json:"inputDuringTurn"`
	WaitingThroughRestart bool `json:"waitingThroughRestart"`
	ContinuesAfterRestart bool `json:"continuesAfterRestart"`
}

func objects(v any) []object {
	var out []object
	_ = json.Unmarshal(mustJSON(v), &out)
	return out
}
func usageOut(u api.Usage) object {
	return object{"input": u.Input, "output": u.Output, "cacheRead": u.Cached, "cacheWrite": u.CacheWrite, "cost": u.Cost}
}
func usageIn(u object) api.Usage {
	return api.Usage{Input: number(u, "input"), Output: number(u, "output"), Cached: number(u, "cacheRead"), CacheWrite: number(u, "cacheWrite"), Cost: real(u, "cost")}
}
func outcomeKindOut(o api.Outcome) object {
	v := object{"kind": o.Status}
	if o.Status == "limit" {
		v["limit"] = strings.TrimSuffix(o.Error, " limit")
	} else if o.Error != "" {
		v["error"] = o.Error
	}
	return v
}
func turnResultOut(o api.Outcome) object {
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
func outcomeIn(v object) api.Outcome {
	k, r := asObject(v["outcome"]), asObject(v["result"])
	o := api.Outcome{Status: str(k, "kind"), Error: str(k, "error"), Usage: usageIn(asObject(v["usage"]))}
	if limit := str(k, "limit"); o.Status == "limit" && limit != "" {
		o.Error = limit + " limit"
	}
	if has(r, "text") {
		o.Result = api.Text(str(r, "text"))
	}
	if has(r, "value") {
		o.Value = mustJSON(r["value"])
	}
	var ids []string
	_ = json.Unmarshal(mustJSON(r["openToolCalls"]), &ids)
	for _, id := range ids {
		o.Open = append(o.Open, api.Call{ID: id})
	}
	return o
}

func pendingCallOut(c api.Call, started, repeat bool) object {
	v := object{"id": c.ID, "name": c.Name, "input": c.Input, "started": started, "safeToRepeat": repeat}
	if c.Step != "" {
		v["stepId"] = c.Step
	}
	return v
}
