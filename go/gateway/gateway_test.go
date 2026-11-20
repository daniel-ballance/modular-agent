package gateway_test

import (
	"context"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/gateway"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProviderAcrossGateway(t *testing.T) {
	p := fake.New(fake.Script{Response: api.Response{Content: api.Text("gateway-answer")}, Chunks: api.Text("gateway-answer")})
	ts := httptest.NewServer(gateway.New(p).Handler("token"))
	defer ts.Close()
	c, err := gateway.NewClient(servicehttp.NewClient(ts.URL, "token"))
	if err != nil {
		t.Fatal(err)
	}
	a, err := c.Access("fake")
	if err != nil {
		t.Fatal(err)
	}
	var text string
	out, err := a.Generate(context.Background(), api.Request{}, func(p api.Part) { text += p.Text })
	if err != nil || out.Content.Text() != "gateway-answer" || text != "gateway-answer" {
		t.Fatal(out, text, err)
	}
	if _, err = c.Access("not-in-catalog"); err == nil {
		t.Fatal("unknown model accepted")
	}
	if _, err = gateway.NewClient(servicehttp.NewClient(ts.URL, "wrong")); err == nil {
		t.Fatal("unauthenticated catalog")
	}
}

type failing struct{}

func (failing) Catalog() []api.Model {
	return []api.Model{{ID: "offline", Stateful: true, RunsTools: true}}
}
func (failing) Access(string) (api.ModelAccess, error) { return failingAccess{}, nil }

type failingAccess struct{}

func (failingAccess) Model() api.Model { return api.Model{ID: "offline"} }
func (failingAccess) Generate(ctx context.Context, r api.Request, emit func(api.Part)) (api.Response, error) {
	if r.System == "wait" {
		<-ctx.Done()
		return api.Response{}, ctx.Err()
	}
	return api.Response{}, &api.ModelError{Kind: "overflow", Message: "context too large"}
}
func TestGatewayFailureKindsAndCancellation(t *testing.T) {
	ts := httptest.NewServer(gateway.New(failing{}).Handler("token"))
	defer ts.Close()
	c, err := gateway.NewClient(servicehttp.NewClient(ts.URL, "token"))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := c.Access("offline")
	if !a.Model().Stateful || !a.Model().RunsTools {
		t.Fatal("Provider declarations lost across gateway")
	}
	_, err = a.Generate(context.Background(), api.Request{}, nil)
	var me *api.ModelError
	if !errors.As(err, &me) || me.Kind != "overflow" {
		t.Fatal("lost failure classification", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = a.Generate(ctx, api.Request{System: "wait"}, nil)
	if err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatal(err)
	}
}
