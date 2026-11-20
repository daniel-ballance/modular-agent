// Package modelselect chooses model access above the Runtime.
package modelselect

import (
	"context"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"strings"
)

type Selection struct{ a api.API }

func Plugin() api.Plugin {
	return api.Plugin{Name: "model-selection", Setup: func(a api.API) error {
		s := &Selection{a}
		if err := a.Provide("selection", s); err != nil {
			return err
		}
		if err := a.RegisterCommand("model", s.model); err != nil {
			return err
		}
		return a.RegisterCommand("thinking", s.thinking)
	}}
}
func (s *Selection) Resolve(session api.Session) (api.ModelAccess, error) {
	for _, v := range s.a.All("provider.") {
		p := v.(api.Provider)
		for _, m := range p.Catalog() {
			if m.ID == session.Settings.Model || (m.Provider != "" && m.Provider+"/"+m.ID == session.Settings.Model) {
				return p.Access(m.ID)
			}
		}
	}
	return nil, fmt.Errorf("model not found: %s", session.Settings.Model)
}
func supports(levels []string, level string) bool {
	for _, v := range levels {
		if level == v {
			return true
		}
	}
	return false
}
func (s *Selection) model(ctx context.Context, id string, args []string) (string, error) {
	snap, err := s.a.Snapshot(id)
	if err != nil {
		return "", err
	}
	if len(args) == 0 {
		return snap.Settings.Model, nil
	}
	if len(args) != 1 {
		return "", errors.New("usage: /model [model-id]")
	}
	snap.Settings.Model = args[0]
	access, err := s.Resolve(snap)
	if err != nil {
		return "", err
	}
	snap.Settings.Thinking = api.LowerReasoning(snap.Settings.Thinking, access.Model().Thinking)
	return args[0], s.a.SetSettings(ctx, id, snap.Settings)
}
func (s *Selection) thinking(ctx context.Context, id string, args []string) (string, error) {
	snap, err := s.a.Snapshot(id)
	if err != nil {
		return "", err
	}
	if len(args) == 0 {
		return snap.Settings.Thinking, nil
	}
	if len(args) != 1 {
		return "", errors.New("usage: /thinking [level]")
	}
	snap.Settings.Thinking = strings.ToLower(args[0])
	access, err := s.Resolve(snap)
	if err != nil {
		return "", err
	}
	if !supports(access.Model().Thinking, snap.Settings.Thinking) {
		return "", errors.New("unsupported thinking level")
	}
	return snap.Settings.Thinking, s.a.SetSettings(ctx, id, snap.Settings)
}
