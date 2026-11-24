package modular

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/runreceipt"
)

// RunReceipt distinguishes release of an exchange's terminal from settlement
// of the work it followed. Neither status proves client delivery or execution.
type RunReceipt struct {
	Terminal string `json:"terminal"`
	Work     string `json:"work"`
}

func (h AGUIHost) RunReceipt(ctx context.Context, thread, run string) (RunReceipt, error) {
	var r RunReceipt
	b, err := h.get(ctx, thread, "run-receipt", "runId", run, "application/json")
	if err != nil {
		return r, err
	}
	defer b.Close()
	err = json.NewDecoder(io.LimitReader(b, 1024)).Decode(&r)
	return r, err
}

func (q *agRequest) runReceipt(raw string) error {
	if !q.a.persistent {
		return missing
	}
	run, err := oneQuery(raw, "runId")
	if err != nil || run == "" {
		return invalid
	}
	key := runreceipt.Key(q.id, q.Actor.ID, q.client, run)
	cut, err := q.readCut()
	if errors.Is(err, api.ErrPendingErasure) {
		return missing
	}
	if err != nil {
		return err
	}
	w := runreceipt.Fold(cut.snap.LiveEntries(), key, runreceipt.Marker{})
	if w.Bound.ID == "" || w.Bound.IsErased() {
		return missing
	}
	m, err := runreceipt.Read(q.a.receiptDir, q.id, key)
	if errors.Is(err, os.ErrNotExist) {
		return missing
	}
	if err != nil {
		return unavailable
	}
	r, err := q.receiptView(cut.snap, key, run, m)
	if errors.Is(err, api.ErrOutputWithheld) || errors.Is(err, withheld) {
		return missing
	}
	if err != nil {
		return err
	}
	b, err := q.encode("agui.runReceipt", r)
	if err != nil {
		if errors.Is(err, api.ErrOutputWithheld) || errors.Is(err, withheld) {
			return withheld
		}
		return err
	}
	final, err := q.readCut()
	if err != nil {
		return err
	}
	if final.epoch != cut.epoch {
		return missing
	}
	if len(final.snap.Entries) != len(cut.snap.Entries) || final.snap.Position != cut.snap.Position {
		return unavailable
	}
	check, err := runreceipt.Read(q.a.receiptDir, q.id, key)
	if errors.Is(err, os.ErrNotExist) {
		return missing
	}
	if err != nil || !reflect.DeepEqual(check, m) {
		return unavailable
	}
	q.w.Header().Set("Content-Type", "application/json")
	_, err = q.w.Write(b)
	return err
}
func (q *agRequest) receiptView(s api.Session, key, run string, m runreceipt.Marker) (RunReceipt, error) {
	r := RunReceipt{Terminal: "unknown", Work: "unsettled"}
	w := runreceipt.Fold(s.LiveEntries(), key, m)
	a, err := q.sources(s)
	if err != nil {
		return r, err
	}
	questions := map[string]agObject{}
	calls := map[string]api.Call{}
	seen := map[string]bool{}
	for _, raw := range w.Sources {
		if raw.ID == "" || seen[raw.ID] {
			continue
		}
		seen[raw.ID] = true
		e, err := a.entry(raw)
		if err != nil {
			return r, err
		}
		switch e.Kind {
		case "input.accepted":
			in := api.Decode[api.Input](e.Data)
			if in.Actor != q.Actor.ID || in.ID != api.Decode[api.Input](raw.Data).ID {
				return r, missing
			}
		case "input.returned", "input.withdrawn":
			r.Work = "handedBack"
			if agString(agMap(api.Decode[agObject](e.Wire)["data"]), "reason") == "handled" {
				r.Work = "handled"
			}
		case "question.open":
			v := api.Decode[struct{ Question api.Question }](e.Data).Question
			if v.ID != e.ID || v.Kind == "secret" || len(v.Allowed) > 0 && !slices.Contains(v.Allowed, q.Actor.ID) {
				return r, missing
			}
			interrupt := agInterrupt(v)
			if _, err = q.encode("agui.interrupt", interrupt); err != nil {
				return r, err
			}
			questions[v.ID] = interrupt
		case "question.answer":
			if api.Decode[api.Answer](e.Data).Actor != q.Actor.ID {
				return r, missing
			}
		case "tool.started":
			call := api.Decode[api.Call](e.Data)
			if call.ID != e.Call {
				return r, missing
			}
			if _, err = q.exact(api.Event{Kind: "interface.handoff", Turn: e.Turn, Step: e.Step, Call: e.Call, Actor: q.Actor.ID, Data: api.JSON(call)}); err != nil {
				return r, err
			}
			calls[e.Call] = call
		case "tool.result":
			if _, err = q.exact(api.Event{Kind: "tool.end", Turn: e.Turn, Step: e.Step, Call: e.Call, Data: e.Data}); err != nil {
				return r, err
			}
		case "turn.end":
			out := api.Decode[api.Outcome](e.Data)
			g, err := q.gate(api.Event{Kind: "turn.end", Turn: e.Turn, Data: e.Data})
			if err != nil {
				return r, err
			}
			if out.Status != api.Decode[api.Outcome](raw.Data).Status || out.Status != api.Decode[api.Outcome](g.Data).Status {
				return r, missing
			}
			switch out.Status {
			case "completed", "cancelled", "failed", "limit":
				r.Work = out.Status
			default:
				return r, missing
			}
		}
	}
	if m.Class == "" {
		return r, nil
	}
	terminal := agObject{"type": "RUN_FINISHED", "threadId": q.id, "runId": run}
	out := agObject{"type": m.Class}
	terminal["outcome"] = out
	switch m.Class {
	case "interrupt":
		items := []agObject{}
		for _, id := range m.Questions {
			if questions[id] == nil {
				return r, missing
			}
			items = append(items, questions[id])
		}
		if len(items) == 0 {
			return r, missing
		}
		out["interrupts"] = items
	case "success", "cancelled":
		if len(m.Calls) > 0 {
			out["pendingToolCallIds"] = m.Calls
		}
	case "error":
		terminal = agObject{"type": "RUN_ERROR", "code": m.Code, "message": "Run could not be delivered."}
	default:
		return r, missing
	}
	end, err := q.encode("agui.event", terminal)
	if err != nil {
		return r, err
	}
	if len(m.Calls) > 0 {
		group := []json.RawMessage{}
		x := agExchange{agRequest: q}
		for _, id := range m.Calls {
			c, ok := calls[id]
			if !ok {
				return r, missing
			}
			frames, err := x.toolFrames(c, agHistory{}, nil)
			if err != nil {
				return r, err
			}
			for _, b := range frames {
				group = append(group, b)
			}
		}
		group = append(group, end)
		if _, err = q.encode("agui.release", group); err != nil {
			return r, err
		}
	}
	r.Terminal = m.Class
	return r, nil
}
func (q *agRequest) exact(e api.Event) (api.Event, error) {
	g, err := q.gate(e)
	if err == nil && (g.OutputChanged || !agSameBytes(e.Data, g.Data)) {
		err = withheld
	}
	return g, err
}
