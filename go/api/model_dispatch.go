package api

import "context"

// FinalModelDispatch is the Harness's commit and final authority check. For
// wire Providers it runs when the Provider asks for its final request, not
// when the host sends the initial RPC.
type FinalModelDispatch struct {
	Commit func(context.Context, Request) error
	Replay bool
}

type finalModelDispatchKey struct{}

func WithFinalModelDispatch(ctx context.Context, d FinalModelDispatch) context.Context {
	return context.WithValue(ctx, finalModelDispatchKey{}, d)
}

func FinalDispatch(ctx context.Context) FinalModelDispatch {
	d, _ := ctx.Value(finalModelDispatchKey{}).(FinalModelDispatch)
	return d
}

// HookedModelAccess implements the final request boundary inside Generate.
// A Provider without request middleware need not implement it; the caller
// then owns the check immediately before Generate.
type HookedModelAccess interface {
	ModelAccess
	UsesFinalModelDispatch()
}
