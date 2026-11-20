package pluginrpc

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
)

// Local Providers get the same standard hook payloads as external Providers.
// External Providers dispatch their own points through host/hook instead.
type localProvider struct {
	api.Provider
	host *host
	id   string
}

func (p *localProvider) Available() bool { return providerAvailable(p.Provider) }
func (p *localProvider) Access(id string) (api.ModelAccess, error) {
	access, err := p.Provider.Access(id)
	if err != nil {
		return nil, err
	}
	return &localAccess{ModelAccess: access, provider: p}, nil
}
func (p *localProvider) Discard(ctx context.Context, id string) error {
	if d, ok := p.Provider.(interface {
		Discard(context.Context, string) error
	}); ok {
		return d.Discard(ctx, id)
	}
	return nil
}

func (p *localProvider) EraseState(ctx context.Context, id string, entryIDs []string) (api.ProviderErasure, error) {
	if eraser, ok := p.Provider.(api.ProviderEraser); ok {
		return eraser.EraseState(ctx, id, entryIDs)
	}
	return api.ProviderErasure{}, fault("not_supported", "Provider cannot erase remote state")
}

type localAccess struct {
	api.ModelAccess
	provider *localProvider
}

func (a *localAccess) UsesFinalModelDispatch() {}

func (a *localAccess) Generate(ctx context.Context, request api.Request, emit func(api.Part)) (api.Response, error) {
	p := a.provider
	execution := api.Executing(ctx)
	model := a.Model()
	model.Provider = p.id
	payload := object{"sessionId": execution.Session, "provider": p.id, "model": modelOut(model), "request": requestValue(request)}
	fence := api.FinalDispatch(ctx)
	prepared := payload
	if !fence.Replay {
		transformed, err := p.host.a.Invoke(ctx, "binding.provider.request", payload)
		if err != nil {
			return api.Response{}, err
		}
		prepared = asObject(transformed)
	}
	if has(prepared, "refused") {
		return api.Response{}, errors.New(str(prepared, "refused"))
	}
	final := asObject(prepared["request"])
	if fence.Commit != nil {
		if err := fence.Commit(ctx, requestIn(final)); err != nil {
			return api.Response{}, err
		}
	}
	if err := ctx.Err(); err != nil {
		return api.Response{}, err
	}
	response, err := a.ModelAccess.Generate(ctx, requestIn(final), emit)
	if ctx.Err() != nil {
		return api.Response{}, ctx.Err()
	}
	if errors.Is(err, context.Canceled) || Code(err) == "cancelled" {
		return api.Response{}, err
	}
	msg := responseOut(response)
	if err != nil {
		msg["stop"] = "failed"
		msg["error"] = errorOut(err)
	}
	_, _ = p.host.a.Invoke(ctx, "binding.provider.response", providerResponsePayload(payload, msg))
	return response, err
}
