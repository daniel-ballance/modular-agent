package modular

import (
	"context"
	"os"
	"strings"
)

type environmentCredentials struct{}

func (environmentCredentials) Get(ctx context.Context, id string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", appError(err, CancelledCode)
	}
	name := strings.ToUpper(strings.ReplaceAll(id, "-", "_")) + "_API_KEY"
	if key := os.Getenv(name); key != "" {
		return key, nil
	}
	return "", nil
}
