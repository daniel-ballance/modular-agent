package modular

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"slices"
	"strings"
)

func (x *agExchange) project(e api.Event) error {
	if err := x.fresh(x.epoch); err != nil {
		return err
	}
	if e.Turn != "" && e.Turn != x.turn {
		if x.turn != "" {
			return nil
		}
		snap, err := x.a.a.Snapshot(x.id)
		if err != nil {
			return err
		}
		if !x.matches(snap, e.Turn) {
			return nil
		}
		x.turn = e.Turn
	}
	if e.Turn == "" && !strings.HasPrefix(e.Kind, "plugin.") {
		return nil
	}
	switch e.Kind {
	case "turn.start":
		h, err := x.history(e.Turn)
		if err != nil {
			return err
		}
		return x.sendSnapshot(h)
	case "step.start":
		if x.steps[e.Step] {
			return nil
		}
		x.steps[e.Step] = true
		return x.event(agObject{"type": "STEP_STARTED", "stepName": e.Step})
	case "step.end":
		return x.closeStep(e.Step)
	case "model.delta":
		p := api.Decode[api.Part](e.Data)
		switch p.Type {
		case "text":
			return x.appendText(e.Step, p.Text)
		case "reasoning":
			if p.Text == "" {
				return nil
			}
			id := "ma:reasoning:" + e.Step
			if !x.reasoning[e.Step] {
				for _, v := range []agObject{{"type": "REASONING_START", "messageId": id}, {"type": "REASONING_MESSAGE_START", "messageId": id, "role": "reasoning"}} {
					if err := x.event(v); err != nil {
						return err
					}
				}
				x.reasoning[e.Step] = true
			}
			return x.event(agObject{"type": "REASONING_MESSAGE_CONTENT", "messageId": id, "delta": p.Text})
		case "toolInput":
			return x.custom("toolInput", agObject{"stepId": e.Step})
		}
	case "model.stream.end":
		h, err := x.history()
		if err != nil {
			return err
		}
		for _, m := range h.messages {
			if m["id"] == assistantID(e.Step) {
				text := agString(m, "content")
				old := x.text[e.Step]
				if strings.HasPrefix(text, old) {
					if err = x.appendText(e.Step, strings.TrimPrefix(text, old)); err != nil {
						return err
					}
				}
				break
			}
		}
		return x.closeText(e.Step)
	case "tool.requested":
		return x.custom("toolCall", agObject{"toolCallId": e.Call})
	case "tool.progress":
		return x.custom("toolOutput", portable.ToolOutput(e.Call, e.Data))
	case "tool.end":
		r := api.Decode[api.ToolResult](e.Data)
		if r.Call == "" {
			return nil
		}
		h, err := x.history()
		if err != nil {
			return err
		}
		if c, ok := h.starts[e.Call]; ok && h.results[e.Call] != nil && !x.emittedCalls[e.Call] {
			frames, err := x.toolFrames(c, h, h.results[e.Call])
			if err == nil {
				x.emittedCalls[e.Call] = true
				for _, b := range frames {
					if err = x.fresh(h.epoch); err != nil {
						return err
					}
					if err = x.frame(b); err != nil {
						return err
					}
				}
			}
		}
		return x.custom("toolResult", agObject{"toolCallId": e.Call, "status": portable.StatusOut(r.Status)})
	case "history.added":
		v := api.Decode[api.Entry](e.Data)
		if strings.HasPrefix(v.Kind, "plugin.") && v.Writer != "harness" {
			return x.optional(agObject{"type": "CUSTOM", "name": "modular-agent.entry", "value": portable.Entry(v)})
		}
	case "question.open":
		open, err := x.waitingQuestions()
		if err != nil {
			return err
		}
		id := api.Decode[api.Question](e.Data).ID
		if d, ok := open[id]; ok && d.q.Turn == x.turn {
			return x.finish(api.Outcome{Status: "completed"}, []agObject{d.view})
		}
	case "turn.end":
		snap, err := x.a.a.Snapshot(x.id)
		if err != nil {
			return err
		}
		out := api.Decode[api.Outcome](e.Data)
		same := false
		for _, v := range snap.Branch() {
			if v.Kind == "turn.end" && v.Turn == e.Turn {
				raw := api.Decode[api.Outcome](v.Data)
				same = raw.Status == out.Status && slices.EqualFunc(raw.Open, out.Open, func(a, b api.Call) bool { return a.ID == b.ID })
				break
			}
		}
		if !same {
			return withheld
		}
		open, err := x.waitingQuestions()
		if err != nil {
			return err
		}
		var interrupts []agObject
		for _, d := range open {
			if d.q.Turn == x.turn {
				interrupts = append(interrupts, d.view)
			}
		}
		return x.finish(api.Decode[api.Outcome](e.Data), interrupts)
	default:
		if strings.HasPrefix(e.Kind, "plugin.") {
			return x.pluginEvent(e)
		}
		if ev := sdkEvent(e); ev != nil {
			switch v := ev.(type) {
			case DataEvent:
				return x.custom(v.Type, v.Data)
			default:
				if name := eventNames[e.Kind]; name != "" && strings.HasPrefix(name, "job") {
					return x.custom(name, ev)
				}
			}
		}
	}
	return nil
}
func (x *agExchange) appendText(step, text string) error {
	if text == "" {
		return nil
	}
	id := assistantID(step)
	if _, ok := x.text[step]; !ok {
		if err := x.event(agObject{"type": "TEXT_MESSAGE_START", "messageId": id, "role": "assistant"}); err != nil {
			return err
		}
	}
	x.text[step] += text
	return x.event(agObject{"type": "TEXT_MESSAGE_CONTENT", "messageId": id, "delta": text})
}
func (x *agExchange) closeText(step string) error {
	if _, ok := x.text[step]; ok {
		if err := x.event(agObject{"type": "TEXT_MESSAGE_END", "messageId": assistantID(step)}); err != nil {
			return err
		}
		delete(x.text, step)
	}
	if x.reasoning[step] {
		id := "ma:reasoning:" + step
		for _, kind := range []string{"REASONING_MESSAGE_END", "REASONING_END"} {
			if err := x.event(agObject{"type": kind, "messageId": id}); err != nil {
				return err
			}
		}
		delete(x.reasoning, step)
	}
	return nil
}
func (x *agExchange) closeStep(step string) error {
	if err := x.closeText(step); err != nil {
		return err
	}
	if x.steps[step] {
		delete(x.steps, step)
		return x.event(agObject{"type": "STEP_FINISHED", "stepName": step})
	}
	return nil
}
func (x *agExchange) closeStreams() error {
	for step := range x.steps {
		if err := x.closeStep(step); err != nil {
			return err
		}
	}
	for step := range x.text {
		if err := x.closeText(step); err != nil {
			return err
		}
	}
	for step := range x.reasoning {
		if err := x.closeText(step); err != nil {
			return err
		}
	}
	return nil
}
