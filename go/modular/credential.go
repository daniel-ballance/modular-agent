package modular

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/credentials"
	"os"
	"strings"
)

type CredentialStore = api.Credentials
type WritableCredentialStore = api.StagedCredentials

// CredentialStages is staging metadata stored alongside the credential slots.
type CredentialStages = credentials.Stages

// TransactionalCredentials adapts a file sharing its lock and atomic write with another credential format.
type TransactionalCredentials = credentials.Store
type SecretReceipt = api.SecretReceipt
type SecretDecision = api.SecretDecision

const (
	SecretActivated  = api.SecretActivated
	SecretSuperseded = api.SecretSuperseded
	SecretDiscarded  = api.SecretDiscarded
)

func WithCredentials(store CredentialStore) Option {
	return func(o *options) error { o.credentials = store; return nil }
}
func EnvironmentCredentials() CredentialStore             { return environmentCredentials{} }
func FileCredentials(path string) WritableCredentialStore { return credentials.JSONStore(path) }

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
