// Package contextview decides the model's view and appends summaries, never deleting history.
package contextview

import (
	"context"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/turnrun"
	"strings"
)

type manager struct{ a api.API }
type summary struct {
	Covered []string
	Usage   api.Usage
}

func Plugin() api.Plugin { return PluginWithCompaction(true) }

// PluginWithCompaction installs context projection with optional summarization.
func PluginWithCompaction(compact bool) api.Plugin {
	return api.Plugin{Name: "context", Setup: func(a api.API) error {
		m := &manager{a}
		if err := a.Handle("session.fork", "", func(ctx context.Context, v any) (api.Decision, error) {
			fork := v.(api.Forked)
			for i, entry := range fork.Session.Entries {
				if entry.Kind == "summary" {
					meta := api.Decode[summary](entry.Data)
					for j, id := range meta.Covered {
						if mapped, ok := fork.Mapping[id]; ok {
							meta.Covered[j] = mapped
						}
					}
					fork.Session.Entries[i].Data = api.JSON(meta)
				}
			}
			return api.Decision{Value: fork}, nil
		}); err != nil {
			return err
		}
		if compact {
			if err := a.RegisterCommand("compact", func(ctx context.Context, id string, raw string) (string, error) {
				args := strings.Fields(raw)
				if len(args) > 0 {
					return "", errors.New("usage: /compact")
				}
				if err := m.compact(ctx, id); err != nil {
					return "", err
				}
				return "Compacted. Raw history retained.", nil
			}); err != nil {
				return err
			}
		}
		if err := a.Handle("runtime.step.before", "", func(ctx context.Context, v any) (api.Decision, error) {
			sc := v.(api.StepContext)
			if compact && sc.Compact {
				if err := m.compactTurn(ctx, sc); err != nil {
					return api.Decision{}, err
				}
			}
			snap, err := sc.Turn.IO.Snapshot()
			if err != nil {
				return api.Decision{}, err
			}
			sc.Request.Messages, sc.Sources = forProvider(snap, sc.Turn.Access.Model().Provider)
			if len(sc.Turn.Context) > 0 {
				sc.Request.Messages = append(sc.Request.Messages, api.Message{Role: "user", Content: sc.Turn.Context})
			}
			limit := sc.Turn.Access.Model().Context
			if snap.Settings.ContextLimit > 0 {
				limit = snap.Settings.ContextLimit
			}
			if compact && estimate(sc.Request)+sc.Request.MaxOutput > limit {
				if sc.Compact {
					return api.Decision{}, errors.New("context remains too large after compaction")
				}
				if sc.DeferredCompaction {
					err = m.compactTurn(ctx, sc)
				} else {
					err = m.compact(ctx, snap.ID)
				}
				if err != nil {
					return api.Decision{}, err
				}
				snap, err = sc.Turn.IO.Snapshot()
				if err != nil {
					return api.Decision{}, err
				}
				sc.Request.Messages, sc.Sources = forProvider(snap, sc.Turn.Access.Model().Provider)
				if len(sc.Turn.Context) > 0 {
					sc.Request.Messages = append(sc.Request.Messages, api.Message{Role: "user", Content: sc.Turn.Context})
				}
				if estimate(sc.Request)+sc.Request.MaxOutput > limit {
					return api.Decision{}, errors.New("context remains too large after compaction")
				}
			}
			for _, e := range snap.Branch() {
				if e.Kind == "system" {
					sc.Sources = append(sc.Sources, e.ID)
				}
			}
			return api.Decision{Value: sc}, nil
		}); err != nil {
			return err
		}
		if !compact {
			return nil
		}
		return a.Handle("runtime.request.failed", "", func(ctx context.Context, v any) (api.Decision, error) {
			f := v.(api.Failure)
			var modelErr *api.ModelError
			if !errors.As(f.Err, &modelErr) || modelErr.Kind != "context_too_large" {
				return api.Decision{}, nil
			}
			if !f.Context.DeferredCompaction {
				if err := m.compact(ctx, f.Context.Turn.Session); err != nil {
					return api.Decision{}, err
				}
			}
			f.Retry = true
			return api.Decision{Value: f, Answer: true}, nil
		})
	}}
}
func estimate(r api.Request) int { return (len(api.JSON(r)) + 3) / 4 }
func effective(entries []api.Entry) []api.Entry {
	var latest *api.Entry
	for i := range entries {
		if entries[i].Kind == "summary" && entries[i].Visible {
			latest = &entries[i]
		}
	}
	covered := map[string]bool{}
	if latest != nil {
		for _, id := range api.Decode[summary](latest.Data).Covered {
			covered[id] = true
		}
	}
	var out []api.Entry
	if latest != nil {
		out = append(out, *latest)
	}
	for _, e := range entries {
		if e.Visible && e.Kind != "summary" && !covered[e.ID] {
			out = append(out, e)
		}
	}
	return out
}
func (m *manager) compact(ctx context.Context, id string) error {
	return m.compactWith(ctx, id, nil)
}

func (m *manager) compactTurn(ctx context.Context, sc api.StepContext) error {
	return m.compactWith(ctx, sc.Turn.Session, &sc)
}

func (m *manager) compactWith(ctx context.Context, id string, step *api.StepContext) error {
	snap, err := m.a.Snapshot(id)
	if err != nil {
		return err
	}
	view := newView(snap.Branch(), snap.Entries)
	entries := view.entries
	cut := -1
	for i, e := range entries {
		// A long turn can outgrow context on its own. Keep the newest input
		// or complete model/tool batch, not the whole user exchange.
		if e.Kind == "input" || e.Kind == "model" {
			cut = i
		}
	}
	if cut <= 0 {
		return errors.New("no older complete exchange to compact")
	}
	prefix := entries[:cut]
	if len(prefix) == 1 && prefix[0].Kind == "summary" {
		return errors.New("no new older history to compact")
	}
	var access api.ModelAccess
	maxOutput := snap.Settings.MaxOutput
	if step != nil {
		access = step.Turn.Access
		maxOutput = step.Turn.Settings.MaxOutput
	} else {
		selected, err := m.a.Get("selection")
		if err != nil {
			return err
		}
		access, err = selected.(api.Selection).Resolve(snap)
		if err != nil {
			return err
		}
	}
	messages, sources := view.messages(prefix, access.Model().Provider)
	request := api.Request{System: "Summarize this older session history faithfully. Preserve facts, decisions, file paths and unresolved work. Return only a short summary; do not use tools.", Messages: messages, Thinking: "off", MaxOutput: min(maxOutput, 512)}
	var auxiliary api.Entry
	if step != nil {
		io := step.Turn.IO
		id := api.ID()
		commit := func(ctx context.Context, r api.Request) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if len(r.Tools) > 0 {
				return errors.New("compaction cannot offer tools")
			}
			draft := turnrun.ModelRequest(id, access.Model())
			tools := []string{}
			draft.OfferedTools, draft.Copies = &tools, sources
			draft.Wire = api.JSON(map[string]any{"data": map[string]any{"auxiliary": true}})
			var e error
			auxiliary, e = io.Record(ctx, draft)
			if e != nil {
				return e
			}
			if writer, ok := io.(interface{ CheckWriter() error }); ok {
				return writer.CheckWriter()
			}
			return ctx.Err()
		}
		if _, ok := access.(api.HookedModelAccess); ok {
			ctx = api.WithFinalModelDispatch(ctx, api.FinalModelDispatch{Commit: commit})
		} else if err := commit(ctx, request); err != nil {
			return err
		}
	}
	response, err := api.ObserveInference(ctx, access, request, func(api.Part) {})
	if auxiliary.ID != "" && !errors.Is(context.Cause(ctx), api.ErrProcessStopped) {
		if err != nil {
			response.Stop = "failed"
		}
		draft := api.Entry{Kind: "model", Step: auxiliary.Step, Copies: []string{auxiliary.ID}, Data: api.JSON(struct {
			Stop  string
			Usage api.Usage
		}{response.Stop, response.Usage})}
		answered, saveErr := step.Turn.IO.Record(context.WithoutCancel(ctx), draft)
		if saveErr != nil {
			return saveErr
		}
		sources = append(sources, answered.ID)
	}
	if err != nil {
		return fmt.Errorf("compaction: %w", err)
	}
	if response.Content.Text() == "" || response.Stop != "finished" {
		return errors.New("compaction did not return a complete text summary")
	}
	covered := append([]string(nil), sources...)
	for _, e := range prefix {
		if e.Kind == "summary" {
			covered = append(covered, api.Decode[summary](e.Data).Covered...)
		}
	}
	draft := api.Entry{Kind: "summary", Visible: true, Content: response.Content, Copies: sources, Data: api.JSON(summary{Covered: covered, Usage: response.Usage})}
	if step != nil {
		_, err = step.Turn.IO.Record(ctx, draft)
	} else {
		_, err = m.a.Record(ctx, id, draft)
	}
	return err
}
