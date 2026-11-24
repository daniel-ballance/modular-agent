package acpinterface

import (
	"context"
	"crypto/sha256"
	"fmt"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

// InstallApprovalRoute retains the operator policy and view projection, not the
// connection, session attachment or bearer token. A changed scope gets a new ID.
func InstallApprovalRoute(a api.API, project string, policy Principal) string {
	reg, ok := a.(interface {
		RegisterApprovalRoute(string, api.ApprovalRouteCheck)
		SupportsWaitingApprovals() bool
	})
	if !ok || !reg.SupportsWaitingApprovals() {
		return ""
	}
	route := fmt.Sprintf("acp:%x", sha256.Sum256(api.JSON([]any{project, policy.Actor, policy.Projects, policy.Tenants, policy.Represents})))
	reg.RegisterApprovalRoute(route, func(ctx context.Context, q api.Question, _ string) bool {
		who := api.Acting(ctx)
		via := api.ActingVia(ctx)
		if via == "" {
			via = who
		}
		snap, err := a.Snapshot(q.Session)
		if err != nil || snap.Project != project || via != policy.Actor.ID || who != via && !slices.Contains(policy.Represents, who) || policy.Projects != nil && !slices.Contains(policy.Projects, snap.Project) || !(policy.Tenants == nil && snap.Tenant == "" || slices.Contains(policy.Tenants, snap.Tenant)) || policy.Actor.Rights != nil && (!slices.Contains(policy.Actor.Rights, "approve") || !slices.Contains(policy.Actor.Rights, "watch")) || q.ApprovalCall == nil {
			return false
		}
		view := requestValue(q)
		view["call"] = map[string]any{"name": q.ApprovalCall.Name, "input": q.ApprovalCall.Input}
		raw := api.JSON(map[string]any{"requests": []any{view}})
		out, err := a.(outputGate).OutputValue(ctx, api.Event{Kind: "interface.answer", Method: "_modular-agent/requests", Session: q.Session, Data: raw})
		return err == nil && !out.OutputChanged && portable.EqualJSON(raw, out.Data)
	})
	return route
}
func (s *server) approvalContext(ctx context.Context, st *attachment, id, who string) context.Context {
	return api.WithActingVia(s.acting(ctx, id, who), st.actor)
}
