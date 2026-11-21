package modular_test

import (
	"context"
	"fmt"
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
