// Package subagents builds child agents only from sessions, jobs and standard input.
package subagents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
)

type Manager struct {
	a       api.API
	durable bool
	depth   int
}
type detail struct {
	Child      string `json:"child"`
	Task       string `json:"task"`
	Background *bool  `json:"background,omitempty"`
}

func reportPolicy(j api.Job) api.Job {
	if d := api.Decode[detail](j.Detail); d.Background != nil {
		j.Report = *d.Background
	}
	return j
}

func Plugin(durable bool, maxDepth int) api.Plugin {
	if maxDepth <= 0 {
		maxDepth = 3
	}
	return api.Plugin{Name: "subagents", Setup: func(a api.API) error {
		m := &Manager{a: a, durable: durable, depth: maxDepth}
		if err := a.Provide("tools.subagents", m); err != nil {
			return err
		}
		if err := a.Provide("subagents", m); err != nil {
			return err
		}
		if err := a.Handle("session.end", "", func(ctx context.Context, v any) (api.Decision, error) {
			id := v.(string)
			list, _ := m.jobs().List(id)
			for _, j := range list {
				if j.Owner == "subagents" {
					d := api.Decode[detail](j.Detail)
					if _, e := a.Snapshot(d.Child); e == nil {
						_ = a.CloseSession(d.Child)
					}
				}
			}
			return api.Decision{}, nil
		}); err != nil {
			return err
		}
		return a.Handle("session.ready", "", func(ctx context.Context, v any) (api.Decision, error) {
			s := v.(api.Session)
			list, err := m.jobs().List(s.ID)
			if err != nil {
				return api.Decision{}, err
			}
			for _, j := range list {
				if j.Owner == "subagents" && j.State == "running" {
					job := reportPolicy(j)
					_ = m.jobs().Recover(ctx, job, m.recovery(job))
				}
			}
			return api.Decision{}, nil
		})
	}}
}
func (m *Manager) Durable() bool { return m.durable }
func (m *Manager) jobs() api.Jobs {
	v, err := m.a.Get("jobs")
	if err != nil {
		panic(err)
	}
	return v.(api.Jobs)
}
func (m *Manager) Tools(api.Session) []api.Tool {
	return []api.Tool{{Name: "delegate", Description: "Start a subagent with only its task and its own remembered session. Background reports start a later parent turn. Use background=false to wait. Supply session to message a finished child again.", SafeRepeat: true, Input: api.JSON(map[string]any{"type": "object", "properties": map[string]any{"task": map[string]string{"type": "string"}, "session": map[string]string{"type": "string"}, "background": map[string]string{"type": "boolean"}}, "required": []string{"task"}})}}
}
func (m *Manager) Run(ctx context.Context, s api.Session, c api.Call, _ func(string)) api.ToolResult {
	result := api.ToolResult{Call: c.ID, Status: "failed"}
	fail := func(err error) api.ToolResult { result.Content = api.Text(err.Error()); return result }
	var in struct {
		Task       string `json:"task"`
		Session    string `json:"session"`
		Background *bool  `json:"background"`
	}
	if json.Unmarshal(c.Input, &in) != nil || in.Task == "" {
		return fail(errors.New("delegate requires a task"))
	}
	if !m.a.Authorize(s.ID, c.Actor, "delegate") {
		return fail(errors.New("delegation authority refused"))
	}
	if s.Depth >= m.depth {
		return fail(errors.New("subagent depth limit"))
	}
	background := true
	if in.Background != nil {
		background = *in.Background
	}
	key := "delegate:" + c.ID
	list, err := m.jobs().List(s.ID)
	if err != nil {
		return fail(err)
	}
	var j api.Job
	for _, old := range list {
		if old.Owner == "subagents" && old.Key == key {
			j = old
		}
	}
	if j.ID == "" {
		if !m.a.Authorize(s.ID, c.Actor, "jobs") {
			return fail(errors.New("job start refused"))
		}
		child := in.Session
		if child == "" {
			if s.Tenant == "" {
				child, err = m.a.New(ctx, s.Project)
			} else if scoped, ok := m.a.(interface {
				NewInTenant(context.Context, string, string) (string, error)
			}); ok {
				child, err = scoped.NewInTenant(ctx, s.Project, s.Tenant)
			} else {
				return fail(api.ErrTenantForbidden)
			}
			if err != nil {
				return fail(err)
			}
		} else {
			snap, e := m.a.Snapshot(child)
			if e != nil {
				if err = m.a.Open(ctx, child); err != nil {
					return fail(err)
				}
				snap, _ = m.a.Snapshot(child)
			}
			if snap.Parent != s.ID || snap.Project != s.Project || snap.Tenant != s.Tenant {
				return fail(errors.New("not a child of this session"))
			}
			// Only finished subagents can be messaged again.
			for _, old := range list {
				if old.State == "running" && api.Decode[detail](old.Detail).Child == child {
					return fail(errors.New("subagent is still running"))
				}
			}
		}
		if err = m.a.BindChild(ctx, child, s.ID, c.Actor); err != nil {
			return fail(err)
		}
		j = api.Job{Session: s.ID, Turn: api.Executing(ctx).Turn, Actor: c.Actor, Owner: "subagents", Kind: "subagent", Key: key, Detail: api.JSON(detail{Child: child, Task: in.Task, Background: &background}), Report: background}
		j, err = m.jobs().Start(ctx, j, func(jobCtx context.Context) api.Outcome { return m.work(jobCtx, s.ID, key) })
		if err != nil {
			return fail(err)
		}
	} else if j.State == "running" {
		j = reportPolicy(j)
		if err = m.jobs().Recover(ctx, j, m.recovery(j)); err != nil {
			return fail(err)
		}
	}
	d := api.Decode[detail](j.Detail)
	if !background {
		j, err = m.jobs().Wait(ctx, s.ID, j.ID)
		if err != nil {
			return fail(err)
		}
		result.Status = "completed"
		if snap, e := m.a.Snapshot(s.ID); e == nil {
			for _, entry := range snap.Branch() {
				if entry.Kind == "job.end" && entry.Job == j.ID {
					result.Copies = append(result.Copies, entry.ID)
				}
			}
		}
		result.Content = api.Text(fmt.Sprintf("Subagent session %s (%s):\n%s", d.Child, j.State, j.Outcome.Result.Text()))
		if j.Outcome.Error != "" {
			result.Content = api.Text(result.Content.Text() + "\n" + j.Outcome.Error)
		}
		return result
	}
	result.Status = "completed"
	result.Content = api.Text(string(api.JSON(map[string]string{"job": j.ID, "session": d.Child, "state": j.State})))
	return result
}
func (m *Manager) recovery(j api.Job) func(context.Context) api.Outcome {
	return func(ctx context.Context) api.Outcome {
		if !m.durable {
			const unknown = "Subagent interrupted by process stop; outcome unknown. Check outside state before relying on it."
			out := api.Outcome{Status: "failed", Error: unknown}
			if j.Report {
				out.Result = api.Text(unknown)
			}
			return out
		}
		return m.work(ctx, j.Session, j.Key)
	}
}
func (m *Manager) work(ctx context.Context, parent, key string) api.Outcome {
	list, err := m.jobs().List(parent)
	if err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	var j api.Job
	for _, job := range list {
		if job.Key == key && job.Owner == "subagents" {
			j = job
		}
	}
	d := api.Decode[detail](j.Detail)
	child, err := m.a.Snapshot(d.Child)
	if err != nil {
		if err = m.a.Open(ctx, d.Child); err != nil {
			return api.Outcome{Status: "failed", Error: err.Error()}
		}
		child, _ = m.a.Snapshot(d.Child)
	}
	changed := make(chan struct{}, 1)
	stop := m.a.Subscribe(func(e api.Event) {
		if e.Session == d.Child && e.Kind == "turn.end" {
			select {
			case changed <- struct{}{}:
			default:
			}
		}
	})
	defer stop()
	// Recorded input makes a crash between child completion and job completion harmless.
	if _, err = m.a.Submit(ctx, d.Child, api.Input{Copies: []string{j.StartEntry}, Key: "subagent-job:" + j.ID, Actor: child.Actor, When: "after", Content: api.Text(d.Task)}); err != nil {
		return api.Outcome{Status: "failed", Error: err.Error()}
	}
	for {
		out, e := m.a.Wait(ctx, d.Child)
		if e != nil {
			if !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
				_ = m.a.Cancel(d.Child)
				_, _ = m.a.Wait(context.Background(), d.Child)
			}
			return api.Outcome{Status: "cancelled", Error: e.Error()}
		}
		if m.durable && out.Interrupted {
			interruptedTurn := ""
			if snap, err := m.a.Snapshot(d.Child); err == nil {
				for _, entry := range snap.Branch() {
					if entry.Kind == "turn.end" {
						interruptedTurn = entry.Turn
					}
				}
			}
			_, e = m.a.Submit(ctx, d.Child, api.Input{Key: "subagent-recover:" + j.ID + ":" + interruptedTurn, Actor: child.Actor, When: "after", Content: api.Text("Continue the interrupted task. Check unknown outside effects before relying on them.")})
			if e != nil {
				return api.Outcome{Status: "failed", Error: e.Error()}
			}
			continue
		}
		if len(out.Open) == 0 {
			if snap, e := m.a.Snapshot(d.Child); e == nil {
				for _, entry := range snap.Branch() {
					if entry.Kind == "turn.end" {
						out.Copies = []string{entry.ID}
					}
				}
			}
			return out
		}
		select {
		case <-ctx.Done():
			return api.Outcome{Status: "cancelled", Error: ctx.Err().Error()}
		case <-changed:
		}
	}
}
