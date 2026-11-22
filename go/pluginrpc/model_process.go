package pluginrpc

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// ModelProcess is a model-only peer behind an in-process Provider. The outer
// Provider owns host hooks and dispatch. The child gets neither host tools
// nor credentials, even if it makes the corresponding RPC calls.
type ModelProcess struct{ *remoteProvider }

func StartModelProcess(ctx context.Context, spec Spec, project, state, id string) (*ModelProcess, error) {
	r := &remote{exited: make(chan struct{})}
	if err := r.startProcess(spec, project, false); err != nil {
		return nil, err
	}
	r.peer.Handle = r.modelCallback
	r.peer.notify = r.notification
	r.peer.admitNotification = func(ctx context.Context, m envelope) (string, bool) {
		if m.Method != "provider/event" {
			return "", false
		}
		return r.admitNotification(ctx, m)
	}
	r.peer.requestBarrier = hostRequestBarrier
	go func() {
		defer close(r.exited)
		_ = r.peer.Run()
		_ = r.stdin.Close()
		_ = r.cmd.Process.Kill()
		_ = r.cmd.Wait()
	}()
	init := object{"binding": Binding, "data": DataBinding, "host": object{"name": "modular-agent-go", "version": "1"}, "project": project, "home": state, "config": object{}}
	err := r.peer.Call(ctx, "plugin/initialize", init, &r.reg)
	if err == nil {
		err = r.validate()
	}
	if err == nil {
		reg := r.reg
		if len(reg.Providers) != 1 || reg.Providers[0].ID != id || reg.Providers[0].Supports.KeepsState || reg.Providers[0].Supports.RunsTools || len(reg.ToolSources)+len(reg.Hooks)+len(reg.Commands)+len(reg.Replaces) > 0 || reg.Runtime != nil || reg.Environment != nil {
			err = errors.New("expected only a stateless model Provider")
		}
	}
	if err != nil {
		_ = r.Close()
		return nil, err
	}
	r.active.Store(true)
	return &ModelProcess{&remoteProvider{remote: r, reg: r.reg.Providers[0]}}, nil
}

func (p *ModelProcess) Close() error { return p.remote.Close() }

func (p *ModelProcess) Status(ctx context.Context) (bool, string, error) {
	var out struct {
		Available bool
		Reason    string
	}
	err := p.remote.call(ctx, "provider/available", object{"provider": p.reg.ID}, &out)
	return out.Available, out.Reason, err
}

func (p *ModelProcess) Generate(ctx context.Context, session, model string, request json.RawMessage, emit func(api.Part)) (json.RawMessage, error) {
	attempt := &providerAttempt{request: obj(request)}
	ctx = withWork(ctx, work{session: session, provider: p.reg.ID, model: model, event: emit, attempt: attempt})
	params := object{"provider": p.reg.ID, "model": object{"provider": p.reg.ID, "id": model}, "request": attempt.request}
	if session != "" {
		params["sessionId"] = session
	}
	var result json.RawMessage
	if err := p.remote.call(ctx, "provider/request", params, &result); err != nil {
		return nil, err
	}
	if !attempt.matches(obj(result)) {
		return nil, fault("invalid_request", "Provider did not return its authorized response")
	}
	return result, nil
}

func (r *remote) modelCallback(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	if !r.active.Load() || method != "host/hook" {
		return nil, fault("not_supported", "model-only plugin callback")
	}
	v := obj(raw)
	parent, ok := r.peer.requestParent(ctx, mustJSON(v["parentRequestId"]))
	if !ok || parent.Err() != nil {
		return nil, fault("invalid_request", "no active model request")
	}
	w, _ := parent.Value(workKey{}).(work)
	payload := asObject(v["payload"])
	model := asObject(payload["model"])
	hook := str(v, "hook")
	if w.attempt == nil || str(payload, "provider") != w.provider || str(model, "provider") != w.provider || str(model, "id") != w.model || str(payload, "sessionId") != w.session || (hook != "provider.request" && hook != "provider.response") {
		return nil, fault("invalid_request", "callback differs from the active model request")
	}
	return w.attempt.hook(parent, nil, hook, payload)
}
