package api

import "context"

type jobContributorsKey struct{}

// WithJobContributors keeps the users who authorized a turn together when work
// in that turn starts a job. The job's report must not act for just one of them.
func WithJobContributors(ctx context.Context, contributors ...string) context.Context {
	return context.WithValue(ctx, jobContributorsKey{}, contributors)
}

func JobContributors(ctx context.Context) []string {
	contributors, _ := ctx.Value(jobContributorsKey{}).([]string)
	return contributors
}
