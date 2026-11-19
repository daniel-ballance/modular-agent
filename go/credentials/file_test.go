package credentials_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/credentials"
	"os"
	"path/filepath"
	"testing"
)

func TestFileCredentialIsReadOnDemandAndNeverCached(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credential")
	store := &credentials.File{Path: path}
	if _, err := store.Get(context.Background(), "anthropic"); err == nil {
		t.Fatal("missing credential accepted")
	}
	if err := os.WriteFile(path, []byte(" offline-test-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Get(context.Background(), "anthropic"); err != nil || got != "offline-test-token" {
		t.Fatal("credential read failed")
	}
	if err := os.WriteFile(path, []byte("refreshed-test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Get(context.Background(), "anthropic"); err != nil || got != "refreshed-test-token" {
		t.Fatal("credential was cached")
	}
	if _, err := store.Get(context.Background(), "other"); err == nil {
		t.Fatal("unknown credential accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Get(ctx, "anthropic"); err == nil {
		t.Fatal("cancelled credential read accepted")
	}
}
