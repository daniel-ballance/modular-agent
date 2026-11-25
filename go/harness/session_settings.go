package harness

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"time"
)

// SettingsDuringTurn describes the effect of supported model and approval settings.
func (c *client) SettingsDuringTurn() string {
	if c.h.refuseSettings {
		return "refused"
	}
	return "nextTurn"
}

func (c *client) SetSettings(ctx context.Context, id string, settings api.Settings) error {
	if !api.ConnectionAllows(ctx, "settings") || !c.Authorize(id, api.Acting(ctx), "settings") {
		return errors.New("settings refused")
	}
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		if c.h.refuseSettings {
			return api.ErrSettingsBusy
		}
		// Selection and approval changes apply to the next turn. The running
		// turn retains its recorded settings, including across recovery.
		before, after := s.data.Settings, settings
		before.Model, before.Thinking, before.Approval = after.Model, after.Thinking, after.Approval
		before.ApprovalWait = after.ApprovalWait
		before.ModelTools = after.ModelTools
		if before != after {
			return errors.New("non-model settings change applies between turns only")
		}
	}
	next := clone(s.data)
	if settings.ApprovalWait != s.data.Settings.ApprovalWait && (!c.h.SupportsWaitingApprovals() || settings.ApprovalWait != "live" && settings.ApprovalWait != api.UntilDeadline) {
		return errors.New("unsupported approvalWait setting")
	}
	next.Settings = settings
	e := api.Entry{ID: api.ID(), Parent: next.Position, Session: id, Actor: api.Acting(ctx), Writer: c.owner, Time: time.Now().UTC(), Kind: "setting", Data: api.JSON(settings)}
	next.Entries = append(next.Entries, e)
	next.Position = e.ID
	if err := s.commitLocked(next); err != nil {
		return err
	}
	return c.h.afterApprovalChangeLocked(ctx, s)
}
