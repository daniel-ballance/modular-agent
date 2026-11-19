package gateway_test

import (
	"context"
	"fmt"
	"github.com/OWNER/modular-agent/go/anthropic"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/credentials"
	"github.com/OWNER/modular-agent/go/gateway"
	"github.com/OWNER/modular-agent/go/harness"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"github.com/OWNER/modular-agent/go/vanilla"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOnlyGatewayHasModelCredentials(t *testing.T) {
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer offline-gateway-only" {
			t.Error("missing gateway credential")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, e := range []string{`{"type":"message_start","message":{"usage":{"input_tokens":1}}}`, `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"from-gateway"}}`, `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`, `{"type":"message_stop"}`} {
			fmt.Fprintf(w, "data: %s\n\n", e)
		}
	}))
	defer vendor.Close()
	key := filepath.Join(t.TempDir(), "key")
	os.WriteFile(key, []byte("offline-gateway-only"), 0600)
	gh := harness.New()
	defer gh.Close()
	for _, p := range []api.Plugin{credentials.Plugin(key), anthropic.Plugin(vendor.URL, vendor.Client())} {
		if err := gh.Load(p); err != nil {
			t.Fatal(err)
		}
	}
	p, _ := gh.API().Get("provider.anthropic")
	ts := httptest.NewServer(gateway.New(p.(api.Provider)).Handler("service-token"))
	defer ts.Close()
	root := t.TempDir()
	h, err := vanilla.New(vanilla.Options{History: filepath.Join(root, "history"), Provider: gateway.Plugin(servicehttp.NewClient(ts.URL, "service-token"))})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if _, err = h.API().Get("credentials"); err == nil {
		t.Fatal("agent has a credential capability")
	}
	id, err := h.API().New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.API().Submit(context.Background(), id, api.Input{Content: api.Text("hello")})
	if err != nil {
		t.Fatal(err)
	}
	out, err := h.API().Wait(context.Background(), id)
	if err != nil || out.Result.Text() != "from-gateway" {
		t.Fatal(out, err)
	}
	snap, _ := h.API().Snapshot(id)
	if strings.Contains(string(api.JSON(snap)), "offline-gateway-only") {
		t.Fatal("credential leaked")
	}
}
