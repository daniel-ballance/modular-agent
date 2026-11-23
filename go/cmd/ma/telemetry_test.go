package main

import (
	"context"
	"io"

	collect "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
)

func TestTelemetryIsOffWithoutEndpoint(t *testing.T) {
	for _, key := range []string{"ENDPOINT", "TRACES_ENDPOINT", "METRICS_ENDPOINT"} {
		t.Setenv("OTEL_EXPORTER_OTLP_"+key, "")
	}
	t.Setenv("OTEL_SDK_DISABLED", "false")
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
	beforeTraces, beforeMetrics := otel.GetTracerProvider(), otel.GetMeterProvider()
	stop := startTelemetry(t.Context())
	_, span := otel.Tracer("ma-test").Start(t.Context(), "no endpoint")
	span.End()
	stop()
	if otel.GetTracerProvider() != beforeTraces || otel.GetMeterProvider() != beforeMetrics {
		t.Fatal("ma installed an exporter without an endpoint")
	}
}

func TestTelemetryUsesOnlyTheConfiguredSignalEndpoint(t *testing.T) {
	received := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		var spans collect.ExportTraceServiceRequest
		if err != nil || proto.Unmarshal(body, &spans) != nil || len(spans.ResourceSpans) != 1 {
			received <- "bad OTLP payload"
			return
		}
		var service string
		for _, a := range spans.ResourceSpans[0].Resource.Attributes {
			if a.Key == "service.name" {
				service = a.Value.GetStringValue()
			}
		}
		received <- r.URL.Path + " " + r.Header.Get("Content-Type") + " " + service
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer server.Close()
	for key, v := range map[string]string{
		"OTEL_EXPORTER_OTLP_ENDPOINT": "", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": server.URL + "/trace-target", "OTEL_EXPORTER_OTLP_PROTOCOL": "",
		"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "", "OTEL_TRACES_SAMPLER": "always_on",
		"OTEL_SDK_DISABLED": "true",
	} {
		t.Setenv(key, v)
	}
	beforeTraces, beforeMetrics := otel.GetTracerProvider(), otel.GetMeterProvider()
	defer otel.SetErrorHandler(otel.GetErrorHandler())
	defer otel.SetTracerProvider(beforeTraces)
	defer otel.SetMeterProvider(beforeMetrics)
	startTelemetry(t.Context())()
	if otel.GetTracerProvider() != beforeTraces {
		t.Fatal("disabled telemetry installed a provider")
	}
	t.Setenv("OTEL_SDK_DISABLED", "false")
	t.Setenv("OTEL_SERVICE_NAME", "ma-go")
	stop := startTelemetry(t.Context())
	_, span := otel.Tracer("ma-test").Start(context.Background(), "test span")
	span.End()
	stop()
	select {
	case got := <-received:
		if got != "/trace-target application/x-protobuf ma-go" {
			t.Fatalf("wrong exporter request: %q", got)
		}
	default:
		t.Fatal("trace exporter did not send a request")
	}
	if len(received) != 0 || otel.GetMeterProvider() != beforeMetrics {
		t.Fatal("unexpected metrics request or provider")
	}
}
