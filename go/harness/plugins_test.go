package harness_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/harness"
)

func TestPluginCapabilitiesHooksAndReplacement(t *testing.T) {
	h := harness.New()
	var owner api.API
	if err := h.Load(api.Plugin{Name: "owner", Setup: func(a api.API) error {
		owner = a
		if err := a.Provide("example", 7); err != nil {
			return err
		}
		return a.Define("example.transform", api.Transform)
	}}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct{ name, order string }{{"normal", ""}, {"last", "last"}, {"first", "first"}} {
		p := p
		if err := h.Load(api.Plugin{Name: p.name, Setup: func(a api.API) error {
			return a.Handle("example.transform", p.order, func(_ context.Context, v any) (api.Decision, error) {
				return api.Decision{Value: append(v.([]string), p.name)}, nil
			})
		}}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := owner.Invoke(context.Background(), "example.transform", []string{})
	if err != nil || !reflect.DeepEqual(got, []string{"first", "normal", "last"}) {
		t.Fatalf("%v %v", got, err)
	}
	if _, err = h.API().Invoke(context.Background(), "example.transform", nil); err == nil {
		t.Fatal("non-owner invoked hook")
	}
	if err = h.Load(api.Plugin{Name: "clash", Setup: func(a api.API) error { return a.Provide("example", 8) }}); err == nil {
		t.Fatal("duplicate accepted")
	}
	if err = h.Load(api.Plugin{Name: "new-owner", Replaces: "owner", Setup: func(a api.API) error { return a.Provide("example", 9) }}); err != nil {
		t.Fatal(err)
	}
	if got, err := h.API().Get("example"); err != nil || got != 9 {
		t.Fatalf("%v %v", got, err)
	}
	if _, err = owner.Get("example"); err == nil {
		t.Fatal("replaced API still usable")
	}
}

func TestHookRules(t *testing.T) {
	for _, rule := range []api.Rule{api.Observe, api.Gate, api.Transform, api.FirstAnswer, api.Collect} {
		t.Run(string(rule), func(t *testing.T) {
			h := harness.New()
			var a api.API
			calls := 0
			if err := h.Load(api.Plugin{Name: "owner", Setup: func(x api.API) error { a = x; return x.Define("point", rule) }}); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"a", "b"} {
				name := name
				if err := h.Load(api.Plugin{Name: name, Setup: func(x api.API) error {
					return x.Handle("point", "", func(_ context.Context, v any) (api.Decision, error) {
						calls++
						if name == "a" {
							return api.Decision{Value: "changed", Answer: true, Stop: true}, nil
						}
						return api.Decision{Value: "second", Answer: true}, nil
					})
				}}); err != nil {
					t.Fatal(err)
				}
			}
			got, err := a.Invoke(context.Background(), "point", "initial")
			if err != nil {
				t.Fatal(err)
			}
			switch rule {
			case api.Observe:
				if calls != 2 || got != "initial" {
					t.Fatal(got, calls)
				}
			case api.Gate:
				if calls != 2 || got != "second" {
					t.Fatal(got, calls)
				}
			case api.Collect:
				if !reflect.DeepEqual(got, []any{"changed", "second"}) {
					t.Fatal(got)
				}
			default:
				if calls != 1 || got != "changed" {
					t.Fatal(got, calls)
				}
			}
		})
	}
}

func TestGateFailsClosedAndLoadRollsBack(t *testing.T) {
	h := harness.New()
	var a api.API
	_ = h.Load(api.Plugin{Name: "owner", Setup: func(x api.API) error { a = x; return x.Define("guard", api.Gate) }})
	_ = h.Load(api.Plugin{Name: "bad", Setup: func(x api.API) error {
		return x.Handle("guard", "", func(context.Context, any) (api.Decision, error) { return api.Decision{}, errors.New("broken") })
	}})
	if _, err := a.Invoke(context.Background(), "guard", "value"); err == nil {
		t.Fatal("gate error allowed")
	}
	err := h.Load(api.Plugin{Name: "partial", Setup: func(x api.API) error {
		if e := x.Provide("leftover", 1); e != nil {
			return e
		}
		return errors.New("setup failed")
	}})
	if err == nil {
		t.Fatal("load succeeded")
	}
	if _, err = h.API().Get("leftover"); err == nil {
		t.Fatal("failed load leaked registration")
	}
}
