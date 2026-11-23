package pluginrpc_test

import (
	"context"
	"encoding/json"
	"net"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

func TestPluginTraceOfferGatesCallbacks(t *testing.T) {
	const parent = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01"
	for _, offer := range []bool{false, true} {
		name := "legacy host"
		if offer {
			name = "participating host"
		}
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			tp := sdktrace.NewTracerProvider()
			otel.SetTracerProvider(tp)
			defer otel.SetTracerProvider(tracenoop.NewTracerProvider())
			defer tp.Shutdown(context.Background())
			host, child := net.Pipe()
			defer host.Close()
			defer child.Close()
			plugin := &pluginrpc.Server{Registration: pluginrpc.Registration{Binding: pluginrpc.Binding, Name: "trace-fixture"}}
			plugin.Commands = map[string]func(context.Context, pluginrpc.Object) (any, error){
				"check": func(c context.Context, _ pluginrpc.Object) (any, error) {
					return pluginrpc.Object{"traceID": trace.SpanContextFromContext(c).TraceID().String()}, plugin.Callback(c, "host/history", pluginrpc.Object{}, nil)
				},
			}
			done := make(chan struct{})
			go func() { defer close(done); _ = plugin.Serve(ctx, child, child) }()
			defer func() { _ = host.Close(); <-done }()
			enc, dec := json.NewEncoder(host), json.NewDecoder(host)
			dir := t.TempDir()
			params := map[string]any{"binding": pluginrpc.Binding, "data": pluginrpc.DataBinding, "project": dir, "home": dir, "config": map[string]any{}}
			if offer {
				params["traceContext"] = 1
			}
			send := func(v map[string]any) {
				t.Helper()
				v["jsonrpc"] = "2.0"
				if err := enc.Encode(v); err != nil {
					t.Fatal(err)
				}
			}
			read := func() map[string]any {
				t.Helper()
				var v map[string]any
				if err := dec.Decode(&v); err != nil {
					t.Fatal(err)
				}
				return v
			}
			send(map[string]any{"id": 1, "method": "plugin/initialize", "params": params})
			reg, ok := read()["result"].(map[string]any)
			if !ok || (reg["traceContext"] == float64(1)) != offer {
				t.Fatalf("unexpected agreement: %v", reg)
			}
			send(map[string]any{"id": 2, "method": "command/run", "params": map[string]any{"name": "check", "traceContext": map[string]any{"traceparent": parent, "baggage": "sentinel-baggage"}}})
			callback := read()
			cp, ok := callback["params"].(map[string]any)
			if !ok || callback["method"] != "host/history" {
				t.Fatalf("unexpected callback: %v", callback)
			}
			wire, carried := cp["traceContext"].(map[string]any)
			if carried != offer || carried && (len(wire) != 1 || wire["traceparent"] == parent) {
				t.Fatalf("unexpected callback context: %v", wire)
			}
			send(map[string]any{"id": callback["id"], "result": map[string]any{}})
			result := read()
			value, ok := result["result"].(map[string]any)
			if !ok || result["traceContext"] != nil {
				t.Fatalf("unexpected work reply: %v", result)
			}
			if (value["traceID"] == "1234567890abcdef1234567890abcdef") != offer {
				t.Fatal("plugin used a parent without agreement or ignored an agreed parent")
			}
		})
	}
}
