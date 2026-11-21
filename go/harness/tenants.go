package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"os"
)

type TenantConfig struct {
	Rights []string `json:"rights"`
	Tokens *int64   `json:"tokens"`
}

type tenantConfig = TenantConfig

// ConfigureTenants replaces the standalone build's environment-derived policy.
func (h *Harness) ConfigureTenants(tenants map[string]TenantConfig) {
	h.tenants, h.tenantConfigErr = tenants, nil
}

func readTenants() (map[string]tenantConfig, error) {
	raw := os.Getenv("MODULAR_AGENT_TENANTS")
	if raw == "" {
		return nil, nil
	}
	var tenants map[string]tenantConfig
	if err := json.Unmarshal([]byte(raw), &tenants); err != nil || tenants == nil {
		return nil, errors.New("MODULAR_AGENT_TENANTS must be a JSON object")
	}
	for name, t := range tenants {
		if name == "" || t.Rights == nil || t.Tokens != nil && *t.Tokens < 0 {
			return nil, fmt.Errorf("invalid tenant configuration for %q", name)
		}
	}
	return tenants, nil
}

// StdioTenantGrants returns the operator-defined standalone tenant grants.
func (c *client) StdioTenantGrants() ([]string, error) {
	if c.h.tenantConfigErr != nil {
		return nil, c.h.tenantConfigErr
	}
	grants := []string{""}
	for name := range c.h.tenants {
		grants = append(grants, name)
	}
	return grants, nil
}

func (c *client) checkTenant(name string) error {
	if name == "" {
		return nil
	}
	if c.h.tenantConfigErr != nil {
		return c.h.tenantConfigErr
	}
	if _, ok := c.h.tenants[name]; !ok {
		return api.ErrTenantForbidden
	}
	return nil
}

func (c *client) Limit(ctx context.Context, id string, rights []string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	who := api.Acting(ctx)
	uncapped := s.data
	uncapped.Limit = nil
	if !c.authorizedBy(uncapped, ctx, "administer") {
		return api.ErrAuthority
	}
	check := rights
	if rights == nil {
		check = api.Rights
	}
	for _, r := range check {
		if !c.authorizedBy(uncapped, ctx, r) {
			return api.ErrAuthority
		}
	}
	next := s.data
	next.Limit = nil
	if rights != nil {
		next.Limit = &rights
	}
	return s.updateActorsLocked(next, api.Entry{Kind: "limit", Actor: who, Data: api.JSON(rights)}, c.owner)
}

func (c *client) Tenant(ctx context.Context, id string) (map[string]any, error) {
	if !c.Authorize(id, api.Acting(ctx), "watch") {
		return nil, errors.New("watch refused")
	}
	snap, err := c.Snapshot(id)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"tenant": nil, "rights": nil, "tokens": nil}
	if snap.Tenant != "" {
		t := c.h.tenants[snap.Tenant]
		out["tenant"], out["rights"] = snap.Tenant, t.Rights
		if t.Tokens != nil {
			used, err := c.tenantUsage(snap.Tenant)
			if err != nil {
				return nil, err
			}
			out["tokens"] = map[string]int64{"budget": *t.Tokens, "used": used}
		}
	}
	return out, nil
}

// Read the shared ledger on every budget check, including sessions on other
// branches and sessions opened by a different process. A running step counts
// as soon as its response is recorded. Turn totals can include other work.
func (c *client) tenantUsage(name string) (int64, error) {
	sessions, err := c.List("")
	if err != nil {
		return 0, err
	}
	var used int64
	for _, s := range sessions {
		if s.Tenant != name {
			continue
		}
		steps, turns := map[string]int64{}, map[string]int64{}
		for _, e := range s.Entries {
			var usage api.Usage
			switch e.Kind {
			case "model":
				usage = api.Decode[struct{ Usage api.Usage }](e.Data).Usage
			case "turn.end":
				usage = api.Decode[api.Outcome](e.Data).Usage
			default:
				continue
			}
			// A fork copies entries, not the cost of running those turns.
			if s.ForkedFrom != "" && len(e.Copies) != 0 && e.Time.Before(s.Entries[0].Time) {
				continue
			}
			tokens := int64(max(0, usage.Input)) + int64(max(0, usage.Output))
			if e.Kind == "model" {
				steps[e.Turn] += tokens
			} else {
				turns[e.Turn] = tokens
			}
		}
		for turn, tokens := range steps {
			used += max(tokens, turns[turn])
			delete(turns, turn)
		}
		for _, tokens := range turns {
			used += tokens
		}
	}
	return used, nil
}

func (c *client) checkBudget(name string) error {
	budget := c.h.tenants[name].Tokens
	if budget == nil {
		return nil
	}
	if *budget == 0 {
		return api.ErrTenantTokens
	}
	used, err := c.tenantUsage(name)
	if err != nil {
		return err
	}
	if used >= *budget {
		return api.ErrTenantTokens
	}
	return nil
}
