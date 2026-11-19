package turnrun

import (
	"context"
	"errors"
	"fmt"
	"modular/api"
	"sync"
)

const interrupted = "Call did not finish; its outcome is unknown. Check outside state before relying on it. Do not assume its effects did or did not happen."

type pending struct {
	call                   api.Call
	entry                  string
	started, settled, open bool
	recoveredStart, ran    bool
	safeToRepeat           *bool
	result                 *api.ToolResult
}

func definition(tools []api.Tool, name string) (api.Tool, bool) {
	for _, t := range tools {
		if t.Name == name {
			return t, true
		}
	}
	return api.Tool{}, false
}

func (r *Runner) calls(ctx context.Context, t api.Turn, step, model string, calls []api.Call, repair bool) (open []api.Call, err error) {
	if len(calls) == 0 {
		return nil, nil
	}
	bound, isBound := t.IO.(BoundPorts)
	snap, err := t.IO.Snapshot()
	if err != nil {
		return nil, err
	}
	batch := make([]pending, len(calls))
	parallel := len(calls) > 1
	defs := make(map[string]api.Tool)
	for i, call := range calls {
		call.Actor = t.Actor
		if call.Origin == "" {
			call.Origin = "model"
		}
		batch[i].call = call
		def, known := definition(t.Tools, call.Name)
		if isBound && !repair && ctx.Err() == nil {
			def, known, err = bound.Definition(ctx, call.Name)
			if err != nil {
				return nil, err
			}
		}
		if known {
			defs[call.Name] = def
		}
		parallel = parallel && known && def.Parallel
		for _, e := range snap.Branch() {
			if e.Call != call.ID {
				continue
			}
			if e.WasKind("tool.result") {
				batch[i].settled = true
			}
			if e.IsErased() && e.WasKind("tool.started") {
				batch[i].started, batch[i].safeToRepeat = true, nil
			}
			switch e.Kind {
			case "tool.call":
				batch[i].entry = e.ID
			case "tool.started":
				if !t.Continuing || e.Turn == t.ID {
					batch[i].started, batch[i].safeToRepeat = true, e.SafeToRepeat
					if !isBound {
						if saved := api.Decode[api.Call](e.Data); saved.ID == call.ID {
							batch[i].call.Input = saved.Input
						}
					}
				}
			case "tool.open":
				if !isBound {
					batch[i].started = false
				}
			}
		}
		batch[i].recoveredStart = t.Resume && batch[i].started
	}
	var workers sync.WaitGroup
	var errorsMu sync.Mutex
	var settleErrors error
	settle := func(p *pending) (saveErr error) {
		if errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			return nil
		}
		if p.settled || (!isBound && p.entry == "") {
			return nil
		}
		// A refusal, cancellation or other failed check on recovery does
		// not tell us what happened during the original execution.
		if p.recoveredStart && (!p.ran || p.result != nil && (p.result.Status == "refused" || p.result.NotDispatched)) {
			p.open = false
			p.result = &api.ToolResult{Status: "unknown", Content: api.Text(interrupted)}
		}
		if p.open || (p.result != nil && p.result.Status == "open") {
			p.open = true
			if isBound {
				p.settled = true
				return nil
			}
			_, e := t.IO.Record(context.Background(), api.Entry{Kind: "tool.open", Step: step, Call: p.call.ID})
			p.settled = e == nil
			return e
		}
		if p.result == nil {
			status, text := "not_started", "Call did not start before the process stopped."
			if p.started {
				status, text = "unknown", interrupted
			}
			if ctx.Err() != nil {
				status, text = "cancelled", "Turn cancelled before this call finished."
			}
			p.result = &api.ToolResult{Status: status, Content: api.Text(text)}
		}
		result := *p.result
		// Repaired stand-ins bypass after hooks: their status must remain truthful.
		if !repair && !(p.started && p.result.Status == "unknown") {
			func() {
				defer func() {
					if v := recover(); v != nil {
						saveErr = fmt.Errorf("after-tool panic: %v", v)
					}
				}()
				changed, hookErr := t.IO.Hook(context.Background(), "runtime.tool.after", api.AfterTool{Call: p.call, Result: result})
				if hookErr != nil {
					saveErr = hookErr
				} else {
					result = changed.(api.AfterTool).Result
				}
			}()
		}
		result.Call = p.call.ID
		result.Name = p.call.Name
		result.Reference = p.call.Reference
		sources := append(append([]string{}, p.result.Copies...), result.Copies...)
		if p.entry != "" {
			sources = append(sources, p.entry)
		} else if model != "" {
			sources = append(sources, model)
		}
		_, e := t.IO.Record(context.Background(), api.Entry{Kind: "tool.result", Step: p.call.Step, Call: p.call.ID, Visible: true, Content: result.Content, Data: api.JSON(result), Copies: sources})
		if e == nil {
			p.settled = true
			t.IO.Emit(context.Background(), api.Event{Kind: "tool.end", Step: p.call.Step, Call: p.call.ID, Data: api.JSON(result)})
		}
		return errors.Join(saveErr, e)
	}
	defer func() {
		if v := recover(); v != nil {
			err = errors.Join(err, fmt.Errorf("tool pipeline panic: %v", v))
		}
		workers.Wait()
		err = errors.Join(err, settleErrors)
		if errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
			return
		}
		for i := range batch {
			p := &batch[i]
			err = errors.Join(err, settle(p))
			if p.open {
				open = append(open, p.call)
			}
		}
	}()
	// The response already carries the whole request list for a bound turn.
	// Keep the extra call index only for native turns and standalone calls.
	for i := range batch {
		p := &batch[i]
		if step != "" {
			p.call.Step = step
		}
		if isBound || p.entry != "" {
			continue
		}
		var sources []string
		if model != "" {
			sources = []string{model}
		}
		e, saveErr := t.IO.Record(ctx, api.Entry{Kind: "tool.call", Step: step, Call: p.call.ID, Data: api.JSON(p.call), Copies: sources})
		if saveErr != nil {
			return nil, saveErr
		}
		p.entry = e.ID
		t.IO.Emit(ctx, api.Event{Kind: "tool.requested", Step: step, Call: p.call.ID, Data: api.JSON(p.call)})
	}
	for i := range batch {
		p := &batch[i]
		if p.settled {
			continue
		}
		def, known := defs[p.call.Name]
		safe := p.safeToRepeat != nil && *p.safeToRepeat && def.SafeRepeat && t.CanRepeat
		if isBound {
			safe = bound.CanRepeatCall(p.call.ID)
		}
		launched := false
		switch {
		case repair:
			continue
		case ctx.Err() != nil:
			p.result = &api.ToolResult{Status: "cancelled", Content: api.Text("Turn cancelled before this call.")}
		case p.started && !safe:
			p.result = &api.ToolResult{Status: "unknown", Content: api.Text(interrupted)}
		case known && !api.CanCall(def, p.call.Origin):
			p.result = &api.ToolResult{Status: "refused", Content: api.Text("tool does not allow this caller")}
		case !known:
			p.result = &api.ToolResult{Status: "failed", Content: api.Text("unknown or unavailable tool: " + p.call.Name)}
		default:
			checked, hookErr := t.IO.Hook(ctx, "runtime.tool.before", api.ToolCheck{Session: t.Session, Turn: t.ID, Call: p.call, Definition: def})
			if errors.Is(hookErr, api.ErrQuestionOpen) {
				p.open = true
				break
			}
			if hookErr != nil {
				p.result = &api.ToolResult{Status: "refused", Content: api.Text(hookErr.Error())}
				break
			}
			check := checked.(api.ToolCheck)
			if check.Open {
				p.open = true
				break
			}
			if check.Refused != "" {
				p.result = &api.ToolResult{Status: "refused", Content: api.Text(check.Refused)}
				break
			}
			check.Call.ID, check.Call.Name = p.call.ID, p.call.Name
			check.Call.Actor, check.Call.Origin = p.call.Actor, p.call.Origin
			check.Call.Reference = p.call.Reference
			if check.Validate != nil {
				if err := check.Validate(check.Call); err != nil {
					p.result = &api.ToolResult{Status: "refused", Content: api.Text(err.Error())}
					break
				}
			}
			if !isBound {
				safeToRepeat := def.SafeRepeat && t.CanRepeat
				_, err = t.IO.Record(ctx, api.Entry{Kind: "tool.started", Step: p.call.Step, Call: p.call.ID, Copies: []string{p.entry}, Data: api.JSON(check.Call), SafeToRepeat: &safeToRepeat})
				if err != nil {
					return nil, err
				}
				t.IO.Emit(ctx, api.Event{Kind: "tool.started", Step: p.call.Step, Call: p.call.ID})
			}
			p.started = true
			run := func() {
				defer workers.Done()
				defer func() {
					if recover() != nil {
						p.result = &api.ToolResult{Status: "unknown", Content: api.Text(interrupted)}
					}
					if parallel {
						// Results are committed in completion order, not request order.
						// Step preparation puts them back in request order for the model.
						if e := settle(p); e != nil {
							errorsMu.Lock()
							settleErrors = errors.Join(settleErrors, e)
							errorsMu.Unlock()
						}
					}
				}()
				if check.Validate != nil {
					if err := check.Validate(check.Call); err != nil {
						p.result = &api.ToolResult{Status: "refused", Content: api.Text(err.Error())}
						return
					}
				}
				if err := ctx.Err(); err != nil {
					p.result = &api.ToolResult{Status: "cancelled", Content: api.Text(err.Error())}
					return
				}
				p.ran = true
				result := t.IO.RunTool(api.WithExecution(ctx, api.Execution{Session: t.Session, Turn: t.ID, Call: check.Call}), check.Call)
				p.result = &result
			}
			workers.Add(1)
			if parallel {
				launched = true
				go run()
			} else {
				run()
			}
		}
		if !launched {
			if err = settle(p); err != nil {
				return nil, err
			}
		}
	}
	return nil, nil
}
