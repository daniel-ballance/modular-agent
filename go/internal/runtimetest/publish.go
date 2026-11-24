package runtimetest

import (
	"context"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Publish admits and declines a proposal. The fixture gets a kept session
// without consuming a scripted model reply or leaving work to recover.
func Publish(t *testing.T, a api.API, id string) {
	t.Helper()
	s, err := a.Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	ctx := api.AsActor(t.Context(), s.Actor)
	r, err := a.Submit(ctx, id, api.Input{When: "propose", Content: api.Text("fixture setup")})
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.(interface {
		ReleaseInput(context.Context, string, string, string, bool) (api.Receipt, error)
	}).ReleaseInput(ctx, id, r.ID, "", true)
	if err != nil {
		t.Fatal(err)
	}
}
