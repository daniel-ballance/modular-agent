package harness

import (
	"context"
	"slices"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
)

func (c *client) statefulErasureProviders() map[string]api.Provider {
	all := map[string]api.Provider{}
	c.h.mu.RLock()
	for key, registration := range c.h.caps {
		if id, ok := strings.CutPrefix(key, "provider."); ok {
			all[id] = registration.value.(api.Provider)
		}
	}
	c.h.mu.RUnlock()
	for id, p := range all {
		if !slices.ContainsFunc(p.Catalog(), func(m api.Model) bool { return m.Stateful }) {
			delete(all, id)
		}
	}
	return all
}

// Provider deletion is idempotent. A lost reply or lost acknowledgement in
// the registry leaves the same operation pending for a later writer.
func (c *client) retryProviderDeletion(ctx context.Context, registry api.ErasureCoordinator, intent api.ErasureIntent, providers map[string]api.Provider) []string {
	var report []string
	for i, debt := range intent.Providers {
		if debt.Complete {
			continue
		}
		provider := providers[debt.Provider]
		if discard, ok := provider.(interface {
			Discard(context.Context, string) error
		}); ok {
			if err := discard.Discard(ctx, debt.SessionID); err != nil {
				report = append(report, "unconfirmed Provider deletion")
				continue
			}
		}
		eraser, ok := provider.(api.ProviderEraser)
		if !ok {
			report = append(report, "unconfirmed Provider deletion")
			continue
		}
		var targets []string
		for _, copy := range intent.Copies {
			if copy.SessionID == debt.SessionID {
				targets = append(targets, copy.ID)
			}
		}
		answer, err := eraser.EraseState(ctx, debt.SessionID, targets)
		if err != nil || len(answer.Pending) != 0 || len(answer.OutOfReach) != 0 {
			report = append(report, "unconfirmed Provider deletion")
			continue
		}
		err = registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
			for j := range *intents {
				current := &(*intents)[j]
				if current.ID == intent.ID && i < len(current.Providers) && current.Providers[i].SessionID == debt.SessionID && current.Providers[i].Provider == debt.Provider {
					current.Providers[i].Complete = true
					return nil
				}
			}
			return api.ErrErasureUnavailable
		})
		if err != nil {
			report = append(report, "unconfirmed Provider deletion")
		}
	}
	return report
}

// Check before recording a new dispatch intent, not during recovery or write
// settlement. Ordinary history views remain available after local deletion.
func (c *client) checkProviderErasure(ctx context.Context, id string) error {
	v, _ := c.Get("history")
	registry := api.PendingRegistry(v)
	if registry == nil {
		return nil
	}
	var pending []api.ErasureIntent
	err := registry.PendingErasures(func(intents *[]api.ErasureIntent) error {
		for _, intent := range *intents {
			var debts []api.ErasureProvider
			// Preserve debt indices; mark other sessions complete in this view.
			for _, debt := range intent.Providers {
				debt.Complete = debt.Complete || debt.SessionID != id
				debts = append(debts, debt)
			}
			if slices.ContainsFunc(debts, func(debt api.ErasureProvider) bool { return !debt.Complete }) {
				intent.Providers = debts
				pending = append(pending, intent)
			}
		}
		return nil
	})
	if err != nil || len(pending) == 0 {
		return err
	}
	providers := c.statefulErasureProviders()
	for _, intent := range pending {
		if len(c.retryProviderDeletion(ctx, registry, intent, providers)) != 0 {
			return api.ErrErasureUnavailable
		}
	}
	return nil
}
