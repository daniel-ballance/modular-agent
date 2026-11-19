package pluginrpc

import (
	"context"
	"errors"
	"modular/api"
)

func (p *runtimeClient) Hook(ctx context.Context, name string, raw any) (any, error) {
	var hook string
	payload := object{}
	switch v := raw.(type) {
	case api.Turn:
		hook = "turn.start"
	case api.AfterStep:
		hook = "step.after"
		payload = object{"stepId": v.Step, "response": answerValue(v.Response)}
	case api.ToolCheck:
		hook = "tool.before"
		payload = object{"call": callOut(v.Call), "definition": toolOut(v.Definition)}
	case api.AfterTool:
		hook = "tool.after"
		payload = object{"call": callOut(v.Call), "result": resultOut(v.Result)}
	case api.Failure:
		hook = "model.failed"
		payload = object{"request": requestValue(v.Context.Request), "error": errorOut(v.Err)}
	case api.ResultCheck:
		hook = "turn.result"
		payload["result"] = object{"text": v.Result.Text()}
		if len(v.Value) > 0 {
			asObjectResult := payload["result"].(object)
			asObjectResult["value"] = v.Value
		}
	case api.Outcome:
		hook = "turn.end"
		payload["outcome"], payload["result"] = outcomeKindOut(v), turnResultOut(v)
	default:
		return nil, fault("invalid_request", "unsupported Runtime hook: "+name)
	}
	var answer object
	if err := p.call(ctx, "hook", object{"hook": hook, "payload": payload}, &answer); err != nil {
		return raw, err
	}
	value := asObject(answer["value"])
	switch v := raw.(type) {
	case api.ToolCheck:
		v.Refused, v.Open = str(answer, "refused"), has(answer, "pending")
		if v.Refused != "" {
			result := resultIn(asObject(answer["result"]))
			if v.Open || result.Call != v.Call.ID || (result.Status != "refused" && result.Status != "unknown") {
				return nil, fault("invalid_request", "tool refusal lacks the committed result")
			}
		}
		if has(value, "call") {
			call := callIn(asObject(value["call"]))
			v.Call.Input, v.Call.Wire = call.Input, call.Wire
		}
		return v, nil
	case api.AfterTool:
		if has(answer, "result") {
			v.Result = resultIn(asObject(answer["result"]))
		}
		return v, nil
	case api.AfterStep:
		if refused := str(answer, "refused"); refused != "" {
			return nil, errors.New(refused)
		}
		if has(value, "response") {
			v.Response = responseIn(asObject(value["response"]))
		}
		return v, nil
	case api.Failure:
		v.Retry = boolean(answer, "retry")
		v.Context.Request = api.Request{}
		if has(answer, "request") {
			v.Context.Request = requestIn(asObject(answer["request"]))
		}
		return v, nil
	case api.ResultCheck:
		v.Continue = str(answer, "refused")
		if result := asObject(value["result"]); has(result, "text") && str(result, "text") != v.Result.Text() {
			v.Result = api.Text(str(result, "text"))
		}
		if result := asObject(value["result"]); has(result, "value") {
			v.Value = mustJSON(result["value"])
		}
		return v, nil
	default:
		return raw, nil
	}
}
