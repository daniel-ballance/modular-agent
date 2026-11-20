package modular_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func serveStore(ctx context.Context, address, storeDir, tokenFile string) error {
	return modular.ServeHistory(ctx, modular.FileHistory(storeDir),
		modular.HistoryOptions{Address: address, TokenFile: tokenFile})
}

func connectHistory(ctx context.Context, project, dataDir, url, tokenFile string) (*modular.Agent, error) {
	return modular.New(ctx,
		modular.WithProject(project),
		modular.WithDataDir(dataDir),
		modular.WithDurability(modular.Kept),
		modular.WithHistory(modular.HTTPHistory(url, tokenFile)),
		modulartest.Script(`[{"text": "Whitby."}, {"text": "14:02."}]`),
		modular.WithModel("scripted/script"))
}

func handoff(t *testing.T, ctx context.Context, project, writerDir, readerDir, url, tokenFile string) {
	t.Helper()
	writer, err := connectHistory(ctx, project, writerDir, url, tokenFile)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close(ctx)
	first, err := writer.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if turn, err := first.Prompt(ctx, "Name a harbour."); err != nil || turn.Text != "Whitby." {
		t.Fatalf("first turn: %+v, %v", turn, err)
	}
	id := first.ID()
	if err := writer.Close(ctx); err != nil { // Give up the writer lease.
		t.Fatal(err)
	}

	reader, err := connectHistory(ctx, project, readerDir, url, tokenFile)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(ctx)
	reopened, err := reader.OpenSession(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if turn, err := reopened.LastTurn(ctx); err != nil || turn == nil || turn.Text != "Whitby." {
		t.Fatalf("saved turn: %+v, %v", turn, err)
	}
	if turn, err := reopened.Prompt(ctx, "When is high tide there?"); err != nil || turn.Text != "14:02." {
		t.Fatalf("next turn: %+v, %v", turn, err)
	}
	history, err := reopened.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var actors []any
	for _, entry := range history {
		if entry["kind"] == "input" {
			actors = append(actors, entry["actorId"])
		}
	}
	if !slices.Equal(actors, []any{"user", "user"}) {
		t.Fatalf("input actor ids: %v", actors)
	}
}

func TestHandsOffASessionOverHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tmp := t.TempDir()
	project := t.TempDir()
	tokenFile := filepath.Join(tmp, "token")
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte(hex.EncodeToString(secret[:])+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := reserved.Addr().String()
	reserved.Close()

	done := make(chan error, 1)
	go func() { done <- serveStore(ctx, address, filepath.Join(tmp, "history"), tokenFile) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	dialer := net.Dialer{}
	for {
		conn, err := dialer.DialContext(ctx, "tcp", address)
		if err == nil {
			conn.Close()
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("history service did not start")
		case <-time.After(10 * time.Millisecond):
		}
	}
	handoff(t, ctx, project, filepath.Join(tmp, "writer"), filepath.Join(tmp, "reader"),
		"http://"+address, tokenFile)
}
