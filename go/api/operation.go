package api

import "context"

// WithOperationEntry binds the first operation of one authenticated exchange
// to its source entry. The ID is opaque; no client or run name enters history.
type operationEntryKey struct{}

func WithOperationEntry(ctx context.Context, session, id string) context.Context {
	return context.WithValue(ctx, operationEntryKey{}, [2]string{session, id})
}
func OperationEntry(ctx context.Context, s Session) (string, error) {
	p, _ := ctx.Value(operationEntryKey{}).([2]string)
	if p[0] != s.ID || p[1] == "" {
		return "", nil
	}
	for _, e := range s.LiveEntries() {
		if e.ID == p[1] {
			return "", ErrInputConflict
		}
	}
	return p[1], nil
}
