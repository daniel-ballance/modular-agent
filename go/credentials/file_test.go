package credentials_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/credentials"
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
	if err := os.Mkdir(path+".d", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path+".d", fmt.Sprintf("%x", sha256.Sum256([]byte("other")))), []byte("stale"), 0600); err != nil {
		t.Fatal(err)
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
