package modular_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func requireCode(t *testing.T, err error, code modular.Code) {
	t.Helper()
	var e *modular.Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("want %s; got %v", code, err)
	}
}

func TestSessionAuthorityOptions(t *testing.T) {
	ctx := t.Context()
	guest := modular.Actor{ID: "guest", Kind: "user", Rights: []string{"watch", "input", "propose"}}
	t.Run("off", func(t *testing.T) {
		a := modulartest.Agent(t)
		s, err := a.Session(ctx)
		if err != nil {
			t.Fatal(err)
		}
		d := a.Declaration()
		if d["severalActors"] != false || d["sessionLimits"] != false || d["tenants"] != false {
			t.Fatalf("authority enabled by default: %+v", d)
		}
		_, err = s.As(guest.ID)
		requireCode(t, err, modular.NotSupported)
		requireCode(t, s.Join(ctx, guest), modular.NotSupported)
		requireCode(t, s.Leave(ctx, guest.ID), modular.NotSupported)
		requireCode(t, s.SetLimit(ctx, nil), modular.NotSupported)
		_, err = s.Send(ctx, "park me", modular.Propose)
		requireCode(t, err, modular.NotSupported)
		_, err = a.Session(ctx, modular.SessionOptions{Tenant: "team"})
		requireCode(t, err, modular.NotSupported)
	})
	t.Run("enabled", func(t *testing.T) {
		a := modulartest.Agent(t, modular.WithSeveralActors(true), modular.WithSessionLimits(true),
			modular.WithTenants(map[string]modular.Tenant{"team": {Rights: []string{"watch", "input", "grant", "administer"}}}),
			modulartest.Script(`[{"text":"Hello."}]`))
		d := a.Declaration()
		if d["severalActors"] != true || d["sessionLimits"] != true || d["tenants"] != true {
			t.Fatalf("missing authority declaration: %+v", d)
		}
		_, err := a.Session(ctx, modular.SessionOptions{Tenant: "unknown"})
		requireCode(t, err, modular.Forbidden)
		s, err := a.Session(ctx, modular.SessionOptions{Tenant: "team", Actors: []modular.Actor{guest}})
		if err != nil {
			t.Fatal(err)
		}
		view, err := s.As(guest.ID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = view.As("user")
		requireCode(t, err, modular.Forbidden)
		_, err = view.Send(ctx, "park me", modular.Propose)
		requireCode(t, err, modular.Forbidden)
		if err = s.SetLimit(ctx, []string{"watch"}); err != nil {
			t.Fatal(err)
		}
		_, err = view.Prompt(ctx, "Say hello.")
		requireCode(t, err, modular.Forbidden)
		if err = s.SetLimit(ctx, []string{"watch", "input", "grant"}); err != nil {
			t.Fatal(err)
		}
		requireCode(t, s.SetLimit(ctx, nil), modular.Forbidden) // The tenant does not grant every standard right.
		turn, err := view.Prompt(ctx, "Say hello.")
		if err != nil || turn.Text != "Hello." {
			t.Fatalf("turn=%+v, %v", turn, err)
		}
		history, err := s.History(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var recorded bool
		for _, e := range history {
			if e["kind"] == "inputAccepted" && e["actorId"] == guest.ID {
				raw, err := json.Marshal(e["data"])
				if err != nil {
					t.Fatal(err)
				}
				var data struct{ SubmittedBy string }
				if err = json.Unmarshal(raw, &data); err != nil {
					t.Fatal(err)
				}
				recorded = data.SubmittedBy == "user"
			}
		}
		if !recorded {
			t.Fatal("input lacks represented actor or submitting principal")
		}
		if err = s.Leave(ctx, guest.ID); err != nil {
			t.Fatal(err)
		}
		_, err = view.Prompt(ctx, "Say hello.")
		requireCode(t, err, modular.Forbidden)
	})
}
