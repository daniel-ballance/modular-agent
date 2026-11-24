package modular_test

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
)

func (f *agFixture) checkpoint(name, id, run string) {
	k := name + ":" + id
	f.mu.Lock()
	held, ok := f.holds[k]
	if ok && (run == "" || held == "" || run == held) {
		delete(f.holds, k)
	} else {
		ok = false
	}
	f.mu.Unlock()
	if ok {
		f.pause(k)
		return
	}
	switch name {
	case "waitFollowing", "presenceLost":
		f.signal(k)
	case "terminalRecorded":
		f.signal(k + ":" + run)
	}
}
func (f *agFixture) hostReadGate(recipient string, e *api.Event) bool {
	if f.Name == "receipt-result" && e.Kind == "tool.end" {
		f.checkpoint("afterResult", e.Session, "")
	}
	if recipient != "kit-primary" {
		return false
	}
	f.mu.Lock()
	mode, id := f.gateMode, f.gateID
	f.mu.Unlock()
	if mode == "settlement" && e.Kind == "turn.end" || mode == "reply" && e.Method == "agui.runReceipt" {
		return true
	}
	if e.Method == "agui.runReceipt" && (mode == "terminal" || mode == "work") {
		v := api.Decode[map[string]string](e.Data)
		if mode == "terminal" {
			v[mode] = "unknown"
		} else {
			v[mode] = "unsettled"
		}
		e.Data = api.JSON(v)
	}
	if id != "" && e.Kind == "history.added" {
		v := api.Decode[api.Entry](e.Data)
		if mode == "opening" && v.ID == id || mode == "decision" && v.Kind == "question.answer" && api.Decode[api.Answer](v.Data).Request == id {
			return true
		}
	}
	if mode == "notice" && e.Kind == "modular-agent.waitClosed" {
		item := api.Decode[map[string]any](e.Data)
		if item["requestId"] == id {
			item["reason"] = "changed"
			e.Data = api.JSON(item)
		}
	}
	return false
}
func (s *kitStore) PendingErasures(fn func(*[]api.ErasureIntent) error) error {
	var id string
	err := s.Store.PendingErasures(func(p *[]api.ErasureIntent) error {
		n := len(*p)
		err := fn(p)
		if err == nil && len(*p) > n {
			id = (*p)[n].Source
		}
		return err
	})
	if err == nil && id != "" {
		s.fixture.checkpoint("pendingErasure", id, "")
	}
	return err
}

// A free-standing ask has no running turn for host.Wait to join. Wait for
// each due timer's committed decision or pending checkpoint instead.
func (f *agFixture) advanceWaits(ctx context.Context, id string, ms int64) error {
	port := f.host.(interface {
		CommittedSnapshot(string) (api.Session, <-chan struct{}, error)
	})
	snap, _, err := port.CommittedSnapshot(id)
	if err != nil {
		return err
	}
	p, _ := f.host.Get("questions")
	due := map[string]bool{}
	until := worktime.Now().Add(time.Duration(ms) * time.Millisecond)
	for _, q := range p.(api.Questions).Recorded(snap) {
		if q.Answerable && q.Deadline != nil && !q.Deadline.After(until) {
			due[q.ID] = true
		}
	}
	f.clock.advance(ms)
	for len(due) != 0 {
		s, next, err := port.CommittedSnapshot(id)
		if err != nil {
			return err
		}
		for _, e := range s.Branch() {
			switch e.Kind {
			case "question.answer":
				delete(due, api.Decode[api.Answer](e.Data).Request)
			case "tool.open":
				for _, q := range api.Decode[struct{ RequestIDs []string }](e.Data).RequestIDs {
					delete(due, q)
				}
			}
		}
		if len(due) != 0 {
			select {
			case <-next:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	_, err = f.host.Wait(ctx, id)
	return err
}

func (f *agFixture) readControl(ctx context.Context, op, id, name, mode, kind, right, request, run string) (any, bool, error) {
	ctx = api.AsActor(ctx, "kit-owner")
	k := name + ":" + id
	var err error
	switch op {
	case "hold":
		f.mu.Lock()
		if f.holds == nil {
			f.holds = map[string]string{}
		}
		f.holds[k] = run
		delete(f.edges, k)
		delete(f.edges, "release:"+k)
		f.mu.Unlock()
	case "release":
		if name == "" || name == "beforeRelease" {
			return nil, false, nil
		}
		f.signal("release:" + k)
	case "barrier":
		switch name {
		case "recoveryEnded":
			_, err = f.host.Wait(ctx, id)
			return struct{}{}, true, err
		case "terminalRecorded":
			k += ":" + run
		case "waitFollowing", "beforeWaitDelivery", "afterAdmission", "beforeAdmission", "beforeTerminal", "pendingErasure", "terminalReleased":
		case "afterResult":
			if f.Name != "receipt-result" {
				return nil, false, nil
			}
		case "presenceLost":
			if f.Name != "closure-routes" {
				return nil, false, nil
			}
		default:
			return nil, false, nil
		}
		select {
		case <-ctx.Done():
			err = ctx.Err()
		case <-f.edge(k):
		}
	case "expireWaitCursor":
		f.clock.advance((25 * time.Hour).Milliseconds())
	case "receiptGate", "waitGate":
		f.mu.Lock()
		f.gateMode, f.gateID = mode, request
		f.mu.Unlock()
	case "revokeRight":
		snap, e := f.host.Snapshot(id)
		if e != nil {
			return nil, true, e
		}
		actor := snap.Actors["kit-owner"]
		actor.Rights = slices.DeleteFunc(slices.Clone(actor.Rights), func(v string) bool { return v == right })
		err = f.host.Grant(ctx, id, actor)
	case "openWait":
		opened := make(chan string, 1)
		stop := f.host.Subscribe(func(e api.Event) {
			if e.Kind == "question.open" && e.Session == id {
				select {
				case opened <- api.Decode[api.Question](e.Data).ID:
				default:
				}
			}
		})
		defer stop()
		done := make(chan error, 1)
		work := context.WithoutCancel(ctx)
		switch kind {
		case "approval":
			go func() {
				_, e := f.host.CallTool(work, id, api.Call{Name: "review", Input: api.JSON(struct{}{})})
				done <- e
			}()
		case "leaveOpen":
			_, err = f.host.Submit(work, id, api.Input{Actor: "kit-owner", When: "now", Content: api.Text("Ask the fixture question.")})
		default:
			q := api.Question{Session: id, Actor: "kit-owner", Kind: "choice", Prompt: "Choose.", Options: []string{"yes", "no"}}
			if kind == "deadline" {
				q.Wait = 5 * time.Second
			}
			if kind == "revocable" {
				q.Allowed = []string{"kit-owner"}
			}
			p, _ := f.host.Get("questions")
			go func() { _, e := p.(api.Questions).Ask(work, q); done <- e }()
		}
		if err != nil {
			return nil, true, err
		}
		select {
		case v := <-opened:
			return map[string]string{"requestId": v}, true, nil
		case <-ctx.Done():
			err = ctx.Err()
		case err = <-done:
			if err == nil {
				err = errors.New("ask returned before opening")
			}
		}
	default:
		return nil, false, nil
	}
	return struct{}{}, true, err
}
