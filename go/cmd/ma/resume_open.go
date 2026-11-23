package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type resumeCandidate struct {
	row      modular.SessionInfo
	operator modular.ACPActor
}

func (d layout) resumeCandidates(ctx context.Context, o options, store modular.HistoryStore) ([]resumeCandidate, error) {
	if !o.acp && !o.agui {
		return nil, nil
	}
	// This is operator policy, not a session default. Do not merge it with
	// .modular-agent.json, even when the project is trusted.
	var global map[string]any
	path := filepath.Join(d.config, "settings.json")
	if err := readJSON(path, &global); err != nil {
		return nil, err
	}
	if v, set := global["resume_open"]; set {
		enabled, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("%s: resume_open must be a boolean", path)
		}
		o.resumeOpen = o.resumeOpen || enabled
	}
	if !o.resumeOpen {
		return nil, nil
	}
	// A listener starts work for the local operator, not for one of its
	// network clients. Stdio retains its configured local scope.
	operator := modular.ACPActor{Actor: modular.LocalACPActor()}
	if o.listen == "" {
		if p := o.policy.Stdio; p != nil {
			operator = *p
		} else if id, set := os.LookupEnv("MODULAR_AGENT_ACTOR"); set {
			operator.Actor.ID = id
		}
	}
	if !slices.Contains(operator.Actor.Rights, "watch") || operator.Projects != nil && !slices.Contains(operator.Projects, o.project) {
		return nil, nil
	}
	operator.Actor.Rights = []string{"watch"}
	rows, err := store.Sessions(ctx, o.project)
	if err != nil {
		return nil, err
	}
	var out []resumeCandidate
	for _, row := range rows {
		if !row.UnfinishedTurn {
			continue
		}
		if operator.Tenants == nil && row.Tenant == "" || slices.Contains(operator.Tenants, row.Tenant) {
			out = append(out, resumeCandidate{row, operator})
		}
	}
	return out, nil
}
