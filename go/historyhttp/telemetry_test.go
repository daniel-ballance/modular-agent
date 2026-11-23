package historyhttp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestHistoryWaitAndRenewTrace(t *testing.T) {
	mem := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(mem))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() { otel.SetTracerProvider(previous); _ = tp.Shutdown(context.Background()) })
	var acquisitions atomic.Int32
	var renewalParent atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/v1":
			fmt.Fprint(w, `{"binding":"modular-agent-history/1","ttlMs":1000}`)
		case "/v1/sessions/shared/lease":
			if acquisitions.Add(1) == 1 {
				w.WriteHeader(http.StatusConflict)
				fmt.Fprint(w, `{"code":"held","error":"fixture content","retryAfterMs":1}`)
				return
			}
			fmt.Fprint(w, `{"lease":"test-lease","ttlMs":1000}`)
		case "/v1/sessions/shared/lease/test-lease/renew":
			renewalParent.Store(req.Header.Get("traceparent"))
			fmt.Fprint(w, `{"ttlMs":1000}`)
		default:
			t.Errorf("unexpected history path %s", req.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	wire := servicehttp.NewClient(server.URL, "fixture-token")
	client := NewClient(wire)
	defer client.Close()
	ctx, parent := tp.Tracer("fixture").Start(t.Context(), "load")
	defer parent.End()
	if _, err := client.takeLease("shared", true, ctx); err != nil {
		t.Fatal(err)
	}
	// A scheduled renewal is not a child of the unrelated load or active turn.
	if _, err := (httpBackend{wire}).Renew(t.Context(), "shared", "test-lease"); err != nil {
		t.Fatal(err)
	}
	spans := mem.GetSpans()
	if len(spans) != 2 || acquisitions.Load() != 2 {
		t.Fatalf("expected one wait and one renewal: %v", spans)
	}
	wait, renew := spans[0], spans[1]
	attrs := func(s tracetest.SpanStub, key string) string {
		for _, a := range s.Attributes {
			if string(a.Key) == key {
				return a.Value.AsString()
			}
		}
		return ""
	}
	if wait.Name != "modular_agent.capacity.wait" || wait.SpanKind != trace.SpanKindInternal || wait.Parent.SpanID() != parent.SpanContext().SpanID() || attrs(wait, "modular_agent.capacity.scope") != "session" {
		t.Errorf("wrong capacity wait span: %+v", wait)
	}
	carrier, _ := renewalParent.Load().(string)
	if renew.Name != "modular_agent.history.lease.renew" || renew.SpanKind != trace.SpanKindInternal || renew.Parent.IsValid() || attrs(renew, "gen_ai.conversation.id") != "shared" || !strings.Contains(carrier, renew.SpanContext.SpanID().String()) || strings.Contains(fmt.Sprint(renew), "test-lease") {
		t.Errorf("wrong lease renewal span or HTTP parent: %+v, %s", renew, carrier)
	}
}
