package credentials

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/daniel-ballance/modular-agent/go/api"
)

func (f *File) answers() Store { return JSONStore(filepath.Join(f.Path+".d", "answers.json")) }

func (f *File) Put(ctx context.Context, name, value string) error {
	if !f.CanStore(name) {
		return errors.New("credential destination unavailable or reserved")
	}
	return f.answers().Update(ctx, func(s *Stages, answers map[string]string) (bool, error) {
		s.advance(name)
		answers[name] = value
		return true, nil
	})
}

func (f *File) Stage(ctx context.Context, session, request, name, actor, value string) (api.SecretReceipt, error) {
	if !f.CanStore(name) {
		return api.SecretReceipt{}, errors.New("credential destination unavailable or reserved")
	}
	return f.answers().Stage(ctx, session, request, name, actor, value)
}
func (f *File) LookupStaged(ctx context.Context, session, request string) (api.SecretReceipt, bool, error) {
	if f.Path == "" {
		return api.SecretReceipt{}, false, nil
	}
	return f.answers().LookupStaged(ctx, session, request)
}
func (f *File) Activate(ctx context.Context, receipt api.SecretReceipt) (api.SecretDecision, error) {
	if !f.CanStore(receipt.Name) {
		return "", errors.New("credential destination unavailable or reserved")
	}
	return f.answers().Activate(ctx, receipt)
}
func (f *File) Discard(ctx context.Context, session, request string) error {
	if f.Path == "" {
		return nil
	}
	return f.answers().Discard(ctx, session, request)
}
