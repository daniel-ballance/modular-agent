package turnrun

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"

	"github.com/OWNER/modular-agent/go/api"
)

// HostedPorts expose the request-scoped callbacks. Settlement and admission
// belong to the host, including a refusal that never reaches dispatch.
type HostedPorts interface {
	BoundPorts
	ModelAt(context.Context, string, api.Request) (api.Response, error)
	TakeSteeringBoundary(context.Context, bool) (bool, error)
	DispatchTool(context.Context, api.Call) (api.ToolResult, error)
}

func (r *Runner) runHosted(ctx context.Context, t api.Turn, p HostedPorts) (out api.Outcome) {
	fail := func(err error) api.Outcome {
		out.Status, out.Error = "failed", err.Error()
		var limit interface{ TurnLimit() string }
		if errors.As(err, &limit) && limit.TurnLimit() != "" {
			out.Status, out.Error = "limit", limit.TurnLimit()+" limit"
		}
		return out
	}
	defer func() {
		if v := recover(); v != nil {
			out = fail(fmt.Errorf("Runtime panic: %v", v))
		}
		if ctx.Err() != nil {
			out.Status, out.Error = "cancelled", ""
		}
		if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			_, _ = p.Hook(context.WithoutCancel(ctx), "runtime.turn.end", out)
		}
	}()
	if t.Resume {
		snap, err := p.Snapshot()
		if err != nil {
			return fail(err)
		}
		for _, e := range snap.Branch() {
			if e.Turn != t.ID || e.IsErased() {
				continue
			}
			if e.Kind == "model.request" && !api.Decode[struct{ Data struct{ Auxiliary bool } }](e.Wire).Data.Auxiliary {
				out.Steps++
			}
			if e.Kind == "model" && !api.Decode[struct {
				Data struct {
					Recovery  bool
					Auxiliary bool
				}
			}](e.Wire).Data.Auxiliary {
				out.Usage.Add(api.Decode[modelData](e.Data).Usage)
			}
		}
		if !r.Durable {
			out.Interrupted = true
			return fail(errors.New("turn interrupted by process stop"))
		}
		opens, err := hostedCalls(ctx, t, p, t.Interrupted)
		if err != nil {
			return fail(err)
		}
		if step := t.ResumedStep; step != nil {
			if step.Refused != "" {
				return fail(errors.New(step.Refused))
			}
			if !step.Committed {
				if _, err := p.Hook(ctx, "runtime.step.after", api.AfterStep{Step: step.ID, Response: step.Response}); err != nil {
					return fail(err)
				}
			}
			switch step.Response.Stop {
			case "output_limit":
				out.Status, out.Error, out.Result = "limit", "output limit", step.Response.Content
				return out
			case "failed", "refused", "aborted":
				return fail(errors.New("model " + step.Response.Stop))
			}
		}
		if len(opens) > 0 {
			out.Status, out.Open = "completed", opens
			return out
		}
	} else {
		if _, err := p.Hook(ctx, "runtime.turn.start", t); err != nil {
			return fail(err)
		}
		if opens, err := hostedCalls(ctx, t, p, t.Reopen); err != nil {
			return fail(err)
		} else if len(opens) > 0 {
			out.Status, out.Open = "completed", opens
			return out
		}
	}
	var next api.Request
	compacted := false
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		if t.Settings.MaxSteps > 0 && out.Steps >= t.Settings.MaxSteps {
			out.Status, out.Error = "limit", "steps limit"
			return out
		}
		if _, err := p.TakeSteeringBoundary(ctx, false); err != nil {
			return fail(err)
		}
		step, err := p.NewID(ctx)
		if err != nil {
			return fail(err)
		}
		sc := api.StepContext{Turn: t, Step: step, Usage: out.Usage, Request: next}
		if len(next.Wire) == 0 {
			sc, err = p.PrepareStep(ctx, step, out.Usage)
			if err != nil {
				return fail(err)
			}
		}
		response, modelErr := p.ModelAt(ctx, step, sc.Request)
		if response.Stop == "" {
			if modelErr == nil {
				modelErr = errors.New("model did not answer")
			}
			return fail(modelErr)
		}
		_, err = p.Record(context.WithoutCancel(ctx), api.Entry{Kind: "model", Step: step, Visible: true, Content: response.Content, Data: api.JSON(modelData{Stop: response.Stop, Usage: response.Usage, Wire: response.Wire})})
		if err != nil {
			return fail(err)
		}
		out.Steps++
		out.Usage.Add(response.Usage)
		next = api.Request{}
		var retry bool
		var retryErr error
		if response.Stop == "failed" && ctx.Err() == nil {
			if modelErr == nil {
				modelErr = errors.New("model failed")
			}
			var f any
			f, retryErr = p.Hook(ctx, "runtime.request.failed", api.Failure{Context: sc, Err: modelErr})
			if retryErr == nil {
				if decision, ok := f.(api.Failure); ok && decision.Retry {
					retry, next = true, decision.Context.Request
					var model *api.ModelError
					if errors.As(modelErr, &model) && model.Kind == "context_too_large" {
						retry = !compacted && len(next.Wire) == 0
						compacted = true
					}
				}
			}
		}
		var calls []api.Call
		if response.Stop == "tools" || response.Stop == "finished" {
			for _, part := range response.Content {
				if part.Call != nil {
					c := *part.Call
					c.Step = step
					c.Actor = t.Actor
					if c.Origin == "" {
						c.Origin = "model"
					}
					calls = append(calls, c)
				}
			}
		}
		var callErr error
		out.Open, callErr = hostedCalls(ctx, t, p, calls)
		_, afterErr := p.Hook(context.WithoutCancel(ctx), "runtime.step.after", api.AfterStep{Step: step, Response: response})
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		if response.Stop == "output_limit" {
			out.Status, out.Error, out.Result = "limit", "output limit", response.Content
			return out
		}
		if err := errors.Join(callErr, afterErr, retryErr); err != nil {
			return fail(err)
		}
		if retry {
			continue
		}
		switch response.Stop {
		case "failed":
			return fail(modelErr)
		case "refused", "aborted":
			return fail(errors.New("model " + response.Stop))
		}
		if len(out.Open) > 0 {
			out.Status = "completed"
			return out
		}
		if len(calls) > 0 {
			continue
		}
		steering, err := p.TakeSteeringBoundary(ctx, false)
		if err != nil {
			return fail(err)
		}
		if steering {
			continue
		}
		result, err := p.Hook(ctx, "runtime.result", api.ResultCheck{Result: response.Content})
		if err != nil {
			return fail(err)
		}
		checked := result.(api.ResultCheck)
		if checked.Continue != "" {
			continue
		}
		steering, err = p.TakeSteeringBoundary(ctx, true)
		if err != nil {
			return fail(err)
		}
		if steering {
			continue
		}
		out.Status, out.Result, out.Value = "completed", checked.Result, checked.Value
		return out
	}
}

func hostedCalls(ctx context.Context, t api.Turn, p HostedPorts, calls []api.Call) ([]api.Call, error) {
	if len(calls) == 0 {
		return nil, nil
	}
	defs := make([]api.Tool, len(calls))
	parallel := len(calls) > 1
	for i, c := range calls {
		def, ok, err := p.Definition(ctx, c.Name)
		if err != nil {
			return nil, err
		}
		defs[i] = def
		parallel = parallel && ok && def.Parallel
	}
	opens, errs := make([]bool, len(calls)), make([]error, len(calls))
	run := func(i int) {
		c := calls[i]
		v, err := p.Hook(ctx, "runtime.tool.before", api.ToolCheck{Session: t.Session, Turn: t.ID, Call: c, Definition: defs[i]})
		if err != nil {
			errs[i] = err
			return
		}
		check := v.(api.ToolCheck)
		if check.Open {
			opens[i] = true
			return
		}
		if check.Refused != "" {
			return
		}
		result, err := p.DispatchTool(ctx, check.Call)
		errs[i], opens[i] = err, result.Status == "open"
	}
	var group sync.WaitGroup
	for i := range calls {
		if parallel {
			group.Go(func() { run(i) })
		} else {
			run(i)
		}
	}
	group.Wait()
	var open []api.Call
	for i, yes := range opens {
		if yes {
			open = append(open, calls[i])
		}
	}
	return open, errors.Join(slices.DeleteFunc(errs, func(err error) bool { return err == nil })...)
}
