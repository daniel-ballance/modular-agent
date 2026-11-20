package modular_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

const testSecret = "fixture-only-value-not-for-history"

type crashCredentials struct {
	modular.WritableCredentialStore
	point string
}

func (c crashCredentials) Stage(ctx context.Context, s, r, n, a, v string) (modular.SecretReceipt, error) {
	receipt, err := c.WritableCredentialStore.Stage(ctx, s, r, n, a, v)
	if err == nil && c.point == "stage" {
		os.Exit(91)
	}
	return receipt, err
}
func (c crashCredentials) Activate(ctx context.Context, r modular.SecretReceipt) (modular.SecretDecision, error) {
	if c.point == "selection" {
		os.Exit(91)
	}
	d, err := c.WritableCredentialStore.Activate(ctx, r)
	if err == nil && c.point == "activation" {
		os.Exit(91)
	}
	return d, err
}
func secretAgent(ctx context.Context, dir string, store modular.CredentialStore, wire bool, handler modular.QuestionHandler) (*modular.Agent, error) {
	tool := modular.NewTool("secret", "Read a private value.", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		a, err := tc.Ask(ctx, modular.Question{Kind: "secret", Question: "What value?", Credential: "deploy"})
		if a.Declined {
			return "declined", err
		}
		return a.Value, err
	})
	p := modular.Plugin{Name: "secret", Setup: func(r *modular.Registrar) error { return r.Tool(tool) }}
	plugin := modular.WithPlugin(p)
	if wire {
		plugin = modulartest.OverWire(p)
	}
	return modular.New(ctx, modular.WithProject(dir), modular.WithDataDir(filepath.Join(dir, "data")), modular.WithDurability(modular.Kept), modular.WithCredentials(store), modular.WithOnQuestion(handler), plugin,
		modulartest.Script(`[{"toolCalls":[{"name":"secret","input":{}}]},{"text":"Done."}]`))
}
func TestSecretCrash(t *testing.T) {
	if point := os.Getenv("MODULAR_GO_SECRET_CRASH"); point != "" {
		dir := os.Getenv("MODULAR_GO_SECRET_DIR")
		store := crashCredentials{modular.FileCredentials(filepath.Join(dir, "credentials.json")), point}
		a, err := secretAgent(t.Context(), dir, store, false, func(_ context.Context, _ modular.Question) (modular.Answer, error) {
			return modular.Secret(testSecret), nil
		})
		if err != nil {
			t.Fatal(err)
		}
		s, err := a.Session(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "session-id"), []byte(s.ID()), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Prompt(t.Context(), "Ask for a credential."); err != nil {
			t.Fatal(err)
		}
		t.Fatal("no forced crash")
	}
	for _, point := range []string{"stage", "selection", "activation"} {
		t.Run(point, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			dir := t.TempDir()
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			child := exec.CommandContext(ctx, exe, "-test.run=^TestSecretCrash$")
			child.Env = append(os.Environ(), "MODULAR_GO_SECRET_CRASH="+point, "MODULAR_GO_SECRET_DIR="+dir)
			output, err := child.CombinedOutput()
			var status *exec.ExitError
			if !errors.As(err, &status) || status.ExitCode() != 91 || bytes.Contains(output, []byte(testSecret)) {
				t.Fatalf("child did not exit at %s: %v", point, err)
			}
			b, err := os.ReadFile(filepath.Join(dir, "session-id"))
			if err != nil {
				t.Fatal(err)
			}
			store := modular.FileCredentials(filepath.Join(dir, "credentials.json"))
			a, err := secretAgent(ctx, dir, store, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(context.Background())
			s, err := a.OpenSession(ctx, string(b))
			if err != nil {
				t.Fatal(err)
			}
			h, err := s.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(h)
			if err != nil || bytes.Contains(raw, []byte(testSecret)) {
				t.Fatal("secret leaked into history")
			}
			value, err := store.Get(ctx, "deploy")
			if err != nil {
				t.Fatal(err)
			}
			var request string
			for _, e := range h {
				if e["kind"] == "inputRequest" {
					request, _ = e["id"].(string)
				}
			}
			if request == "" {
				t.Fatal("request absent")
			}
			if point == "stage" {
				if value != "" || bytes.Contains(raw, []byte("secretAnswerAccepted")) {
					t.Fatal("unselected stage was used")
				}
				if _, ok, err := store.LookupStaged(ctx, s.ID(), request); err != nil || ok {
					t.Fatalf("stage not discarded: %v, %v", ok, err)
				}
				if _, err := store.Stage(ctx, s.ID(), request, "deploy", "user", "replacement"); err == nil {
					t.Fatal("discarded request allowed restaging")
				}
			} else if value != testSecret || !bytes.Contains(raw, []byte("secretAnswerAccepted")) || !bytes.Contains(raw, []byte(`"stored":"deploy"`)) {
				t.Fatal("selected answer not recovered")
			}
		})
	}
}

func TestSecretToolPlacements(t *testing.T) {
	for _, placement := range []string{"embedded", "served"} {
		t.Run(placement, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			dir := t.TempDir()
			store := modular.FileCredentials(filepath.Join(dir, "credentials.json"))
			a, err := secretAgent(ctx, dir, store, placement == "served", func(_ context.Context, _ modular.Question) (modular.Answer, error) {
				return modular.Secret(testSecret), nil
			})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(context.Background())
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			p, err := s.Prompt(ctx, "Prompt")
			if err != nil {
				t.Fatal(err)
			}
			r := p.ToolResults()
			if len(r) != 1 || r[0].Status != modular.Completed || strings.TrimSpace(r[0].Text()) != "deploy" {
				t.Fatal("tool did not receive just the stored name")
			}
		})
	}
}
