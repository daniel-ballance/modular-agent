package modular_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

func TestFileCredentialsGenerationAndPrivacy(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "credentials.json")
	store := modular.FileCredentials(path)
	first, err := store.Stage(ctx, "session", "first", "private", "user", "one")
	if err != nil {
		t.Fatal(err)
	}
	stale, err := store.Stage(ctx, "session", "stale", "private", "user", "stale")
	if err != nil {
		t.Fatal(err)
	}
	if value, err := store.Get(ctx, "private"); err != nil || value != "" {
		t.Fatalf("staged value visible: %v", err)
	}
	if decision, err := store.Activate(ctx, first); err != nil || decision != modular.SecretActivated {
		t.Fatalf("first activation: %v, %v", decision, err)
	}
	if decision, err := store.Activate(ctx, stale); err != nil || decision != modular.SecretSuperseded {
		t.Fatalf("superseded activation: %v, %v", decision, err)
	}
	latest, err := store.Stage(ctx, "session", "latest", "private", "user", "two")
	if err != nil {
		t.Fatal(err)
	}
	if decision, err := store.Activate(ctx, latest); err != nil || decision != modular.SecretActivated {
		t.Fatalf("latest activation: %v, %v", decision, err)
	}
	store = modular.FileCredentials(path)
	if decision, err := store.Activate(ctx, first); err != nil || decision != modular.SecretActivated {
		t.Fatalf("activation replay: %v, %v", decision, err)
	}
	if decision, err := store.Activate(ctx, stale); err != nil || decision != modular.SecretSuperseded {
		t.Fatalf("superseded replay: %v, %v", decision, err)
	}
	if value, err := store.Get(ctx, "private"); err != nil || value != "two" {
		t.Fatalf("replay modified latest slot: %v", err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Get(ctx, "private"); err == nil {
		t.Fatal("credential file readable by other users was accepted")
	}
}
