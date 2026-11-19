// Package turnrun implements the standard turn protocol shared by Runtime plugins.
package turnrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
	"reflect"
)

type Runner struct{ Durable bool }

// BoundPorts are operations a stdio Runtime must request from its Harness.
// In-process Runtimes retain the native ports and local identity allocation.
type BoundPorts interface {
	api.TurnPorts
	NewID(context.Context) (string, error)
	PrepareStep(context.Context, string, api.Usage) (api.StepContext, error)
	Definition(context.Context, string) (api.Tool, bool, error)
	CanRepeatCall(string) bool
}

func (r *Runner) Declaration() api.RuntimeDeclaration {
	return api.RuntimeDeclaration{Durable: r.Durable, Steering: true, Parallel: true, WaitingThroughRestart: r.Durable}
}

type Start = api.TurnStart
type checkpoint struct {
	Outcome  api.Outcome
	Continue bool
}
type modelData struct {
	Wire  json.RawMessage
	Stop  string
	Usage api.Usage
}

func (r *Runner) Run(ctx context.Context, t api.Turn) (out api.Outcome) {
	if bound, ok := t.IO.(HostedPorts); ok {
		return r.runHosted(ctx, t, bound)
	}
	out.Status = "failed"
	var produced []string
	bound, isBound := t.IO.(BoundPorts)
	defer func() {
		if errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			return
		}
		if p := recover(); p != nil {
			out.Status = "failed"
			out.Error = fmt.Sprintf("Runtime panic: %v", p)
		}
		if ctx.Err() != nil {
			out.Status = "cancelled"
			out.Error = ctx.Err().Error()
		}
		if isBound {
			_, _ = t.IO.Hook(context.Background(), "runtime.turn.end", out)
			return
		}
		_, err := t.IO.Record(context.Background(), api.Entry{Kind: "turn.end", Copies: produced, Data: api.JSON(out)})
		if err != nil {
			out.Status = "failed"
			out.Error = err.Error()
		}
		_, _ = t.IO.Hook(context.Background(), "runtime.turn.end", out)
		t.IO.Emit(context.Background(), api.Event{Kind: "turn.end", Data: api.JSON(out)})
	}()
	fail := func(err error) api.Outcome {
		out.Status, out.Error = "failed", err.Error()
		if errors.Is(err, api.ErrTenantTokens) {
			out.Status = "limit"
		}
		return out
	}
	budget, hasBudget := t.IO.(interface{ CheckTenantBudget() error })
	var pendingStep string
	var pendingModel *api.Entry
	var repeatingModel bool
	var resumed portable.StepAfter
	if t.Resume {
		snap, err := t.IO.Snapshot()
		if err != nil {
			return fail(err)
		}
		var last checkpoint
		hasCheckpoint := false
		seenSteps := map[string]bool{}
		var usage api.Usage
		branch := snap.Branch()
		request, inFlight := InFlightModelRequest(branch, t.ID)
		for _, e := range branch {
			if e.Turn != t.ID {
				continue
			}
			switch e.Kind {
			case "model":
				produced = append(produced, e.ID)
				pendingStep = e.Step
				copy := e
				pendingModel = &copy
				seenSteps[e.Step] = true
				usage.Add(api.Decode[modelData](e.Data).Usage)
			case "step.start":
				if !isBound {
					pendingStep = e.Step
					pendingModel = nil
				}
			case "step.end":
				if !isBound {
					last = api.Decode[checkpoint](e.Data)
					out = last.Outcome
					pendingStep = ""
					pendingModel = nil
					hasCheckpoint = true
				}
			}
		}
		out.Steps, out.Usage = len(seenSteps), usage
		if !r.Durable {
			out.Interrupted = true
			if isBound {
				_, err = r.reconcile(ctx, t, nil, true)
			} else {
				err = r.repairTransient(ctx, t)
			}
			if err != nil {
				return fail(err)
			}
			return fail(errors.New("turn interrupted by process stop"))
		}
		resumed, err = portable.LastAnsweredStep(snap, t.ID)
		if err != nil {
			if repairErr := r.repairTransient(ctx, t); repairErr != nil {
				return fail(errors.Join(err, repairErr))
			}
			return fail(err)
		}
		if resumed.Refused != "" {
			return fail(errors.New(resumed.Refused))
		}
		if isBound {
			open, err := r.reconcile(ctx, t, pendingModel, false)
			if err != nil {
				return fail(err)
			}
			if len(open) != 0 {
				out.Status, out.Open = "completed", open
				return out
			}
		}
		if inFlight {
			if request.SafeToRepeat == nil || !*request.SafeToRepeat {
				return fail(errors.New("interrupted model request has unknown outside effects; not repeated"))
			}
			pendingStep, pendingModel, repeatingModel = request.Step, nil, true
		}
		if hasCheckpoint && pendingStep == "" && !last.Continue {
			return out
		}
		t.IO.Emit(ctx, api.Event{Kind: "turn.resumed"})
	} else {
		if !isBound {
			snap, err := t.IO.Snapshot()
			if err != nil {
				return fail(err)
			}
			var started bool
			for _, e := range snap.Branch() {
				started = started || e.Turn == t.ID && e.Kind == "turn.start"
			}
			if !started {
				if _, err := t.IO.Record(ctx, api.Entry{Kind: "turn.start", Data: api.JSON(Start{StartedBy: t.StartedBy, Model: t.Access.Model(), Input: t.Input, Settings: t.Settings, Tools: t.Tools, Calls: t.Reopen, System: t.System, Context: t.Context})}); err != nil {
					return fail(err)
				}
				t.IO.Emit(ctx, api.Event{Kind: "turn.start"})
			}
		}
		if _, err := t.IO.Hook(ctx, "runtime.turn.start", t); err != nil {
			return fail(err)
		}
	}
	if len(t.Reopen) > 0 {
		open, err := r.calls(ctx, t, "", "", t.Reopen, false)
		if err != nil {
			return fail(err)
		}
		if len(open) > 0 {
			out.Status = "completed"
			out.Open = open
			return out
		}
	}
	saveStep := func(step string, more bool) error {
		if isBound {
			return nil
		}
		_, err := t.IO.Record(ctx, api.Entry{Kind: "step.end", Step: step, Copies: produced, Data: api.JSON(checkpoint{out, more})})
		return err
	}
	for pendingModel != nil || pendingStep != "" || out.Steps < t.Settings.MaxSteps {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		steeringBefore, err := t.IO.TakeSteering(ctx)
		if err != nil {
			return fail(err)
		}
		replayed := pendingModel != nil
		step := pendingStep
		if step == "" {
			if isBound {
				step, err = bound.NewID(ctx)
				if err != nil {
					return fail(err)
				}
			} else {
				step = api.ID()
			}
			if !isBound {
				if _, err := t.IO.Record(ctx, api.Entry{Kind: "step.start", Step: step}); err != nil {
					return fail(err)
				}
			}
		} else if pendingModel == nil && !repeatingModel && (t.Access.Model().Stateful || t.Access.Model().RunsTools) {
			return fail(errors.New("interrupted model request has unknown outside effects; not repeated"))
		}
		pendingStep, repeatingModel = "", false
		if !replayed {
			out.Steps++
		}
		t.IO.Emit(ctx, api.Event{Kind: "step.start", Step: step})
		var response api.Response
		model := api.Entry{}
		if pendingModel != nil {
			model = *pendingModel
			pendingModel = nil
			data := api.Decode[modelData](model.Data)
			response = api.Response{Content: model.Content, Stop: data.Stop, Usage: data.Usage, Wire: data.Wire}
		} else {
			var intent api.Entry
			modelTools := []api.Tool{}
			for _, tool := range t.Tools {
				if api.OffersModelTool(t.Settings, tool) {
					modelTools = append(modelTools, tool)
				}
			}
			sc := api.StepContext{Turn: t, Step: step, Usage: out.Usage, Request: api.Request{System: t.System, Tools: modelTools, Thinking: t.Settings.Thinking, MaxOutput: t.Settings.MaxOutput}}
			prepare := true
			for attempt := 0; attempt < 2; attempt++ {
				err = nil
				if isBound {
					if prepare {
						sc, err = bound.PrepareStep(ctx, step, out.Usage)
					}
				} else if prepare {
					var prepared any
					prepared, err = t.IO.Hook(ctx, "runtime.step.before", sc)
					if err == nil {
						sc = prepared.(api.StepContext)
						sc.Request.Messages = ModelCallOrder(sc.Request.Messages)
					}
				}
				if err != nil {
					return fail(err)
				}
				if hasBudget {
					if err := budget.CheckTenantBudget(); err != nil {
						return fail(err)
					}
				}
				modelCtx := ctx
				finalDispatch := func(dispatchCtx context.Context, req api.Request) error {
					draft := ModelRequest(step, t.Access.Model())
					draft.TracksStepAfter = true
					names := make([]string, 0, len(req.Tools))
					for _, tool := range req.Tools {
						names = append(names, tool.Name)
					}
					draft.OfferedTools = &names
					draft.Copies = sc.Sources
					if len(req.Wire) != 0 {
						draft.Wire = api.JSON(map[string]any{"data": map[string]any{"request": req.Wire}})
					}
					var saveErr error
					intent, saveErr = t.IO.Record(dispatchCtx, draft)
					if saveErr != nil {
						return saveErr
					}
					if writer, ok := t.IO.(interface{ CheckWriter() error }); ok {
						return writer.CheckWriter()
					}
					return dispatchCtx.Err()
				}
				if !isBound {
					if _, hooked := t.Access.(api.HookedModelAccess); hooked {
						modelCtx = api.WithFinalModelDispatch(ctx, api.FinalModelDispatch{Commit: finalDispatch})
					} else if err := finalDispatch(ctx, sc.Request); err != nil {
						return fail(err)
					}
				}
				response, err = t.Access.Generate(modelCtx, sc.Request, func(p api.Part) { t.IO.Emit(ctx, api.Event{Kind: "model.delta", Step: step, Data: api.JSON(p)}) })
				if err == nil {
					break
				}
				t.IO.Emit(ctx, api.Event{Kind: "model.stream.end", Step: step, Data: api.JSON("failed")})
				if attempt == 1 {
					return fail(err)
				}
				if ctx.Err() != nil {
					return fail(ctx.Err())
				}
				f, hookErr := t.IO.Hook(ctx, "runtime.request.failed", api.Failure{Context: sc, Err: err})
				if hookErr != nil {
					return fail(hookErr)
				}
				failure, ok := f.(api.Failure)
				if !ok || !failure.Retry {
					return fail(err)
				}
				if isBound {
					prepare = len(failure.Context.Request.Wire) == 0
				} else {
					prepare = reflect.DeepEqual(sc.Request, failure.Context.Request)
				}
				if !prepare {
					sc = failure.Context
				}
			}
			snap, err := t.IO.Snapshot()
			if err != nil {
				return fail(err)
			}
			seen := map[string]bool{}
			for _, e := range snap.Entries {
				if e.Kind == "tool.call" {
					seen[e.Call] = true
				}
			}
			// A response can be recorded before its call records, so include those identities too.
			for _, e := range snap.Entries {
				if e.Kind == "model" {
					for _, p := range e.Content {
						if p.Call != nil {
							seen[p.Call.ID] = true
						}
					}
				}
			}
			response.Content = append(api.Content(nil), response.Content...)
			for i, part := range response.Content {
				if part.Type != "tool_call" || part.Call == nil {
					continue
				}
				call := *part.Call
				if call.ID == "" || seen[call.ID] {
					if len(part.Data) == 0 {
						response.Content[i].Data = api.JSON(part)
					}
					call.Reference = call.ID
					if isBound {
						call.ID, err = bound.NewID(ctx)
						if err != nil {
							return fail(err)
						}
					} else {
						call.ID = api.ID()
					}
				}
				seen[call.ID] = true
				call.Actor = t.Actor
				if call.Origin == "" {
					call.Origin = "model"
				}
				response.Content[i].Call = &call
			}
			sources := sc.Sources
			if intent.ID != "" {
				sources = []string{intent.ID}
			}
			model, err = t.IO.Record(ctx, api.Entry{Kind: "model", Step: step, Visible: true, Content: response.Content, Copies: sources, Data: api.JSON(modelData{Stop: response.Stop, Usage: response.Usage, Wire: response.Wire})})
			if err != nil {
				return fail(err)
			}
			produced = append(produced, model.ID)
			t.IO.Emit(ctx, api.Event{Kind: "model.stream.end", Step: step})
		}
		if !replayed {
			out.Usage.Add(response.Usage)
		}
		resuming := map[string]api.Call{}
		if replayed && isBound {
			for _, c := range t.Interrupted {
				resuming[c.ID] = c
			}
		}
		var calls []api.Call
		for _, part := range response.Content {
			if part.Type == "tool_call" && part.Call != nil {
				c := *part.Call
				if pending, ok := resuming[c.ID]; ok {
					c = pending
				}
				calls = append(calls, c)
			}
		}
		open, err := r.calls(ctx, t, step, model.ID, calls, false)
		if err != nil {
			return fail(err)
		}
		if hasBudget {
			if err := budget.CheckTenantBudget(); err != nil {
				if errors.Is(err, api.ErrTenantTokens) {
					out.Status, out.Error, out.Open = "limit", err.Error(), open
					return out
				}
				return fail(err)
			}
		}
		if !replayed || !resumed.Committed || resumed.Response.ID != model.ID {
			state := portable.StepAfter{Response: model, Committed: true}
			after, err := t.IO.Hook(ctx, "runtime.step.after", api.AfterStep{Step: step, Response: response})
			if err != nil {
				state.Refused = err.Error()
			} else if checked, ok := after.(api.AfterStep); ok && checked.End {
				state.Refused = "step refused"
			}
			if errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
				return fail(ctx.Err())
			}
			if _, err := t.IO.Record(context.WithoutCancel(ctx), state.Record()); err != nil {
				return fail(err)
			}
			if state.Refused != "" {
				out.Open = open
				return fail(errors.New(state.Refused))
			}
			t.IO.Emit(ctx, api.Event{Kind: "step.end", Step: step, Data: api.JSON(response.Usage)})
		}
		if len(open) > 0 {
			out.Status = "completed"
			out.Open = open
			return out
		}
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		steer, err := t.IO.TakeSteering(ctx)
		if err != nil {
			return fail(err)
		}
		if replayed {
			// Steering already recorded after this response has not yet reached a model.
			snap, err := t.IO.Snapshot()
			if err != nil {
				return fail(err)
			}
			afterModel := false
			for _, e := range snap.Branch() {
				if e.ID == model.ID {
					afterModel = true
				}
				if afterModel && e.Kind == "input" && e.Visible {
					steer = true
				}
			}
			steer = steer || steeringBefore
		}
		more := false
		switch {
		case len(calls) > 0 || steer:
			more = true
		case response.Stop == "failed" || response.Stop == "refused" || response.Stop == "aborted":
			var wire struct {
				Error *api.ModelError `json:"error"`
			}
			_ = json.Unmarshal(response.Wire, &wire)
			if wire.Error != nil {
				return fail(errors.New(wire.Error.Message))
			}
			return fail(errors.New("model " + response.Stop))
		case response.Stop == "output_limit":
			out.Status = "limit"
			out.Error = "output limit"
			out.Result = response.Content
		default:
			checked, err := t.IO.Hook(ctx, "runtime.result", api.ResultCheck{Result: response.Content})
			if err != nil {
				return fail(err)
			}
			check := checked.(api.ResultCheck)
			if check.Continue != "" {
				more = true
			} else {
				out.Status = "completed"
				out.Result = check.Result
				out.Value = check.Value
			}
		}
		if err := saveStep(step, more); err != nil {
			return fail(err)
		}
		if !more {
			return out
		}
	}
	out.Status = "limit"
	out.Error = "step limit"
	return out
}

// Reconcile calls not covered by the response the durable loop will replay.
func (r *Runner) reconcile(ctx context.Context, t api.Turn, replay *api.Entry, repair bool) ([]api.Call, error) {
	var open []api.Call
	skip := map[string]bool{}
	if replay != nil {
		for _, p := range replay.Content {
			if p.Call != nil {
				skip[p.Call.ID] = true
			}
		}
	}
	calls := t.Interrupted
	for i := 0; i < len(calls); {
		step := calls[i].Step
		var batch []api.Call
		for ; i < len(calls) && calls[i].Step == step; i++ {
			if !skip[calls[i].ID] {
				batch = append(batch, calls[i])
			}
		}
		pending, err := r.calls(ctx, t, step, "", batch, repair)
		if err != nil {
			return nil, err
		}
		open = append(open, pending...)
	}
	return open, nil
}

// repairTransient also reconstructs calls from a committed model response whose
// per-call records were not yet written when the process stopped.
func (r *Runner) repairTransient(ctx context.Context, t api.Turn) error {
	snap, err := t.IO.Snapshot()
	if err != nil {
		return err
	}
	for _, e := range snap.Branch() {
		if e.Turn != t.ID || e.Kind != "model" {
			continue
		}
		var calls []api.Call
		for _, part := range e.Content {
			if part.Type == "tool_call" && part.Call != nil {
				calls = append(calls, *part.Call)
			}
		}
		if _, err := r.calls(ctx, t, e.Step, e.ID, calls, true); err != nil {
			return err
		}
	}
	return nil
}
