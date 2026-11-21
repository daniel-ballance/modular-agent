package harness

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/turnrun"
)

// RequestCommandModel dispatches one auxiliary request owned by a running command.
func (c *client) RequestCommandModel(ctx context.Context, id, step string, req api.Request) (api.Response, error) {
	s, err := c.find(id)
	if err != nil {
		return api.Response{}, err
	}
	check := func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.commands == 0 || s.closing || !c.authorizedBy(s.data, ctx, "input") {
			return api.ErrAuthority
		}
		return s.checkWriterLocked()
	}
	if err := check(); err != nil {
		return api.Response{}, err
	}
	snap, err := c.Snapshot(id)
	if err != nil {
		return api.Response{}, err
	}
	selection, err := c.Get("selection")
	if err != nil {
		return api.Response{}, err
	}
	access, err := selection.(api.Selection).Resolve(snap)
	if err != nil {
		return api.Response{}, err
	}
	// Do not grant the Provider authority to execute tools itself.
	if access.Model().RunsTools {
		return api.Response{}, errors.ErrUnsupported
	}
	if req.MaxOutput == 0 {
		req.MaxOutput = snap.Settings.MaxOutput
	}
	if req.MaxOutput < 0 {
		return api.Response{}, errors.New("negative model request output limit")
	}
	if limit := access.Model().Output; limit > 0 && req.MaxOutput > limit {
		req.MaxOutput = limit
	}
	if req.Thinking == "" {
		req.Thinking = snap.Settings.Thinking
	}
	wire := portable.Request(req)
	delete(wire, "sessionId")
	req.Wire = api.JSON(wire)
	var intent api.Entry
	commit := func(ctx context.Context, final api.Request) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := check(); err != nil {
			return err
		}
		if err := c.checkBudget(snap.Tenant); err != nil {
			return err
		}
		draft := turnrun.ModelRequest(step, access.Model())
		draft.Actor = api.Acting(ctx)
		draft.Wire = api.JSON(map[string]any{"data": map[string]any{"request": portable.Request(final)}})
		var err error
		intent, err = c.Record(ctx, id, draft)
		if err != nil {
			return err
		}
		return check()
	}
	ctx = api.WithExecution(ctx, api.Execution{Session: id, Step: step})
	if _, hooked := access.(api.HookedModelAccess); hooked {
		ctx = api.WithFinalModelDispatch(ctx, api.FinalModelDispatch{Commit: commit})
	} else if err := commit(ctx, req); err != nil {
		return api.Response{}, err
	}
	response, err := access.Generate(ctx, req, func(api.Part) {})
	if err != nil && (intent.ID == "" || ctx.Err() != nil) {
		return api.Response{}, err
	}
	if err != nil && response.Stop != "failed" {
		kind := "other"
		var modelError *api.ModelError
		if errors.As(err, &modelError) {
			kind = modelError.Kind
		}
		response = portable.ReadResponse(portable.Object{"role": "assistant", "stop": "failed", "content": []any{}, "error": map[string]any{"kind": kind, "message": err.Error()}})
	}
	if intent.ID == "" {
		return api.Response{}, errors.New("model request was not committed")
	}
	_, err = c.Record(context.WithoutCancel(ctx), id, api.Entry{Kind: "model", Step: step, Actor: api.Acting(ctx), Content: response.Content, Copies: []string{intent.ID}, Data: api.JSON(struct {
		Stop  string
		Usage api.Usage
		Wire  json.RawMessage
	}{response.Stop, response.Usage, response.Wire})})
	return response, err
}
