package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type resumeCandidate struct {
	row      modular.SessionInfo
	operator modular.ACPActor
}

func (d layout) resumeCandidates(ctx context.Context, o options, store modular.HistoryStore, stderr io.Writer) ([]resumeCandidate, error) {
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
	local := modular.ACPActor{Actor: modular.LocalACPActor()}
	operators := []modular.ACPActor{local}
	if o.listen == "" {
		if p := o.policy.Stdio; p != nil {
			operators = []modular.ACPActor{*p}
		} else if id, set := os.LookupEnv("MODULAR_AGENT_ACTOR"); set {
			operators[0].Actor.ID = id
		}
	} else if o.policy.Actors != nil {
		// Never borrow another principal's token rights to start a turn.
		operators = nil
		for _, p := range o.policy.Actors {
			if p.Actor.ID == local.Actor.ID {
				operators = append(operators, p)
			}
		}
	}
	rows, err := store.Sessions(ctx, o.project)
	if err != nil {
		return nil, err
	}
	var out []resumeCandidate
	for _, row := range rows {
		if !row.UnfinishedTurn {
			continue
		}
		i := slices.IndexFunc(operators, func(p modular.ACPActor) bool {
			return slices.Contains(p.Actor.Rights, "watch") && (p.Projects == nil || slices.Contains(p.Projects, row.Project)) && (p.Tenants == nil && row.Tenant == "" || slices.Contains(p.Tenants, row.Tenant))
		})
		if i >= 0 {
			out = append(out, resumeCandidate{row, operators[i]})
		} else {
			fmt.Fprintf(stderr, "skipped %s\n", row.ID)
		}
	}
	return out, nil
}
