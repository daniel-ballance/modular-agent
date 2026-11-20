package portable

import "github.com/daniel-ballance/modular-agent/go/api"

func jobOut(e api.Entry, data object) {
	j := api.Decode[api.Job](e.Data)
	switch e.Kind {
	case "job.start":
		data["kind"] = j.Kind
		set(data, "rights", j.Rights, j.Rights != nil)
		set(data, "key", j.Key, j.Key != "")
		data["detail"] = j.Detail
		set(data, "go.contributors", j.Contributors, len(j.Contributors) != 0)
		// The built-in subagent owner has a report policy before it has a result.
		set(data, "go.report", j.Report, j.Report)
	case "job.end":
		outcome := asObject(data["outcome"])
		outcome["kind"] = j.State
		if !has(outcome, "error") && j.State == "failed" {
			outcome["error"] = j.Outcome.Error
		}
		data["outcome"] = outcome
		data["report"] = j.Report
		set(data, "result", contentOut(j.Outcome.Result), j.ResultPresent || j.Report || j.Outcome.Result != nil || has(data, "result"))
		set(data, "usage", usageOut(j.Outcome.Usage), j.Outcome.Usage != (api.Usage{}))
	}
}

func jobIn(e api.Entry, data object, wireKind string) api.Job {
	if e.Kind == wireKind { // previous Go histories stored an in-process Job
		return api.Decode[api.Job](api.JSON(data))
	}
	j := api.Job{ID: e.Job, Session: e.Session, Turn: e.Turn, Call: e.Call, Actor: e.Actor, Owner: e.Writer}
	if e.Kind == "job.start" {
		j.Kind, j.Key, j.Detail, j.State = str(data, "kind"), str(data, "key"), api.JSON(data["detail"]), "running"
		j.Report = boolean(data, "go.report")
		j.Rights = api.Decode[[]string](api.JSON(data["rights"]))
		j.Contributors = api.Decode[[]string](api.JSON(data["go.contributors"]))
	} else {
		outcome := asObject(data["outcome"])
		j.State, j.Report = str(outcome, "kind"), boolean(data, "report")
		j.ResultPresent = has(data, "result")
		usage := data["usage"]
		if !has(data, "usage") {
			usage = data["go.usage"]
		}
		j.Outcome = api.Outcome{Status: j.State, Error: str(outcome, "error"), Usage: usageIn(asObject(usage)), Copies: e.Copies}
		if j.ResultPresent {
			j.Outcome.Result = contentIn(data["result"])
		}
	}
	return j
}
