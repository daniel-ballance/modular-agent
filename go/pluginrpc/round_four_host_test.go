package pluginrpc_test

import (
	"context"
	"modular/api"
	"modular/conformancemodel"
	"modular/pluginrpc"
	"modular/vanilla"
	"testing"
)

const fakeCredential = `{"test-only":"this entire string is a key"}`

type credentialFixture struct{}

func (credentialFixture) Get(_ context.Context, id string) (string, error) {
	if id == "fixture" {
		return fakeCredential, nil
	}
	return "", nil
}

func TestCredentialCallbacksUseSharedShapeAndOwnership(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("credentials", "")})))
	opt := options(t)
	opt.Provider = api.Plugin{Name: "test-credentials", Setup: func(a api.API) error {
		if err := a.Provide("credentials", credentialFixture{}); err != nil {
			return err
		}
		return a.Provide("provider.conformance", conformancemodel.New())
	}}
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	ctx := context.Background()
	id, err := h.API().New(ctx, opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := h.API().Command(ctx, id, "/fixture"); err != nil || out != "credential callbacks passed" {
		t.Fatal(out, err)
	}
}

func TestRefusalRollsBackTentativeEnvironmentReplacement(t *testing.T) {
	opt := options(t)
	env := &poisonEnvironment{}
	opt.Environment = api.Plugin{Name: "test-environment", Setup: func(a api.API) error {
		return a.Provide("working-environment", env)
	}, Close: env.Close}
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("collision-with-replacement", "")})))
	if err := pluginrpc.LoadEnvironment(h, opt.Project, opt.History); err == nil {
		t.Fatal("registration should have been refused")
	}
	actual, err := h.API().Get("working-environment")
	if err != nil || actual != env || env.closed.Load() {
		t.Fatal("original environment must remain active", err)
	}
	if _, err := h.API().Get("tools.stdio.0.fixture"); err == nil {
		t.Fatal("refused source leaked into registry")
	}
}
