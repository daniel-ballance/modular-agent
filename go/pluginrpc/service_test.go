package pluginrpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
)

func TestNetworkPendingWorkPingsAndSettlesLost(t *testing.T) {
	token := "test-only-308aa296e8853a26b4d720"
	methods := make(chan string, 2)
	svc, err := wswire.Listen(t.Context(), "127.0.0.1:0", nil, wswire.Plugin, map[string]bool{token: true}, func(_ context.Context, c *wswire.Conn, _ bool) {
		for {
			b, err := c.ReadMessage()
			if err != nil {
				return
			}
			var v envelope
			_ = json.Unmarshal(b, &v)
			methods <- v.Method // withhold both answers
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	r := &remote{}
	if err := r.startService(t.Context(), Spec{URL: svc.URL, TokenFile: tokenFile, PingInterval: 20 * time.Millisecond, ControlDeadline: 250 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	defer r.peer.Close()
	go func() { _ = r.peer.Run() }()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := r.peer.Call(ctx, "tools/call", object{}, nil); Code(err) != "lost" {
		t.Fatalf("call = %v, want lost", err)
	}
	for _, want := range []string{"tools/call", "$/ping"} {
		select {
		case got := <-methods:
			if got != want {
				t.Fatalf("method = %s, want %s", got, want)
			}
		default:
			t.Fatalf("did not receive %s", want)
		}
	}
}
