package modular_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type demoEnvironment struct {
	modular.WorkingEnvironment // unused operations in this fixture
	ended                      chan string
}

func (e demoEnvironment) Declaration() modular.EnvironmentDeclaration {
	return modular.EnvironmentDeclaration{Containment: "none", ConfinesFiles: true}
}
func (e demoEnvironment) Read(_ context.Context, p modular.EnvironmentPath) ([]byte, error) {
	return []byte(p.SessionID + " " + p.Cwd + " " + p.Path), nil
}
func (e demoEnvironment) SessionEnded(_ context.Context, id string) error { e.ended <- id; return nil }

func TestServedEnvironmentRejectsUnassignedProjectBeforeSetup(t *testing.T) {
	allowed, denied := t.TempDir(), t.TempDir()
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte("test-token-at-least-128-bits-long"), 0600); err != nil {
		t.Fatal(err)
	}
	var setups atomic.Int32
	p := modular.Plugin{Name: "scoped-environment", Replaces: []string{"working-environment"}, Setup: func(r *modular.Registrar) error {
		setups.Add(1)
		return r.Environment(modular.NewEnvironment(demoEnvironment{ended: make(chan string, 1)}))
	}}
	svc, err := modular.ServeService(t.Context(), p, modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: file, Projects: []string{allowed}})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	opt := modular.WithServicePlugin(modular.ServicePlugin{URL: svc.URL, TokenFile: file})
	if a, err := modular.New(t.Context(), modular.WithProject(denied), opt); err == nil {
		_ = a.Close(t.Context())
		t.Fatal("unassigned project initialized the environment")
	}
	if setups.Load() != 0 {
		t.Fatal("setup ran before project authorization")
	}
	a, err := modular.New(t.Context(), modular.WithProject(allowed), opt)
	if err != nil || setups.Load() != 1 {
		t.Fatal(setups.Load(), err)
	}
	if err := a.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestCustomEnvironmentAndServedCommandProject(t *testing.T) {
	for _, wire := range []bool{false, true} {
		t.Run(fmt.Sprintf("wire=%v", wire), func(t *testing.T) {
			ctx := t.Context()
			project := t.TempDir()
			ended := make(chan string, 2)
			p := modular.Plugin{Name: "demo-environment", Replaces: []string{"working-environment"}, Setup: func(r *modular.Registrar) error {
				if err := r.Environment(modular.NewEnvironment(demoEnvironment{ended: ended})); err != nil {
					return err
				}
				return r.Command(modular.Command{Name: "where", Description: "Read through the scoped environment", Run: func(ctx context.Context, args string, c *modular.CommandContext) (string, error) {
					b, err := c.Environment.Read(ctx, args)
					return c.Project + " " + string(b), err
				}})
			}}
			opt := modular.WithPlugin(p)
			if wire {
				opt = modulartest.OverWire(p)
			}
			a := modulartest.Agent(t, modular.WithProject(project), opt)
			if a.Declaration()["confinesFiles"] != true {
				t.Fatal("missing environment declaration")
			}
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			got, err := s.RunCommand(ctx, "/where fixture")
			if want := project + " " + s.ID() + " " + project + " fixture"; err != nil || got != want {
				t.Fatalf("want %q, got %q: %v", want, got, err)
			}
			if err = s.Close(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case id := <-ended:
				if id != s.ID() {
					t.Fatalf("closed %q", id)
				}
			default:
				t.Fatal("session cleanup missing")
			}
		})
	}
}
