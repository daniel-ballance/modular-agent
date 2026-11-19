package modular

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHTTPHistoryReopens(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("offline-history-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- serveHistory(ctx, HistoryServiceFiles(t.TempDir()), HistoryOptions{TokenFile: tokenFile}, listener)
	}()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	project := t.TempDir()
	p := Provider{ID: "test", Models: func() []ModelInfo {
		return []ModelInfo{{ModelRef: ModelRef{Provider: "test", ID: "offline"}, ContextWindow: 4000, MaxOutput: 2000}}
	}, Request: func(context.Context, ModelRef, ModelRequest, *ProviderContext) (AssistantMessage, error) {
		return AssistantMessage{Content: Text("kept over HTTP"), Stop: "finished"}, nil
	}}
	opts := []Option{WithProject(project), WithDataDir(t.TempDir()), WithDurability(Kept), WithProvider(p), WithHistory(HTTPHistory("http://"+listener.Addr().String(), tokenFile))}
	a, err := New(ctx, opts...)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(context.Background())
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := s.Prompt(ctx, "Keep this.")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	b, err := New(ctx, opts...)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close(context.Background())
	reopened, err := b.OpenSession(ctx, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	last, err := reopened.LastTurn(ctx)
	if err != nil || last == nil || last.Text != "kept over HTTP" || last.TurnID != turn.TurnID {
		t.Fatalf("last: %#v %v", last, err)
	}
}
