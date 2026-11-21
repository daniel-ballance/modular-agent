package api

import (
	"context"
	"slices"
)

type connectionRightsKey struct{}

// A nil ceiling is unrestricted; a non-nil empty ceiling grants nothing.
func WithConnectionRights(ctx context.Context, rights *[]string) context.Context {
	return context.WithValue(ctx, connectionRightsKey{}, rights)
}

func ConnectionRights(ctx context.Context) *[]string {
	rights, _ := ctx.Value(connectionRightsKey{}).(*[]string)
	return rights
}

func ConnectionAllows(ctx context.Context, right string) bool {
	rights := ConnectionRights(ctx)
	return rights == nil || slices.Contains(*rights, right)
}

func IntersectConnectionRights(a, b *[]string) *[]string {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	both := []string{}
	for _, right := range *a {
		if slices.Contains(*b, right) {
			both = append(both, right)
		}
	}
	return &both
}
