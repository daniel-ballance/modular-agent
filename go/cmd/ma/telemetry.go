package main

import (
	"context"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func telemetryTarget(signal string) (endpoint, protocol string) {
	key := "OTEL_EXPORTER_OTLP_"
	specific := key + strings.ToUpper(signal) + "_"
	endpoint = os.Getenv(specific + "ENDPOINT")
	base := endpoint == ""
	if base {
		endpoint = os.Getenv(key + "ENDPOINT")
	}
	protocol = os.Getenv(specific + "PROTOCOL")
	if protocol == "" {
		protocol = os.Getenv(key + "PROTOCOL")
	}
	if protocol == "" {
		protocol = "http/protobuf"
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", protocol
	}
	if base && protocol == "http/protobuf" {
		u.Path = path.Join(u.Path, "v1", signal)
		u.RawPath = ""
	}
	return u.String(), protocol
}

// ma owns telemetry setup and shutdown. The SDK does not configure providers.
func startTelemetry(ctx context.Context) func() {
	stop := func() {}
	if strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
		return stop
	}
	traces, traceProtocol := telemetryTarget("traces")
	metrics, metricProtocol := telemetryTarget("metrics")
	if traces == "" && metrics == "" {
		return stop
	}
	// Export and configuration errors can include endpoint or header values.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) {}))
	name := os.Getenv("OTEL_SERVICE_NAME")
	if name == "" {
		name = "ma"
	}
	res := resource.NewSchemaless(attribute.String("service.name", name))
	var tp *sdktrace.TracerProvider
	var mp *sdkmetric.MeterProvider
	if traces != "" {
		var exporter sdktrace.SpanExporter
		var err error
		switch traceProtocol {
		case "http/protobuf":
			exporter, err = otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(traces))
		case "grpc":
			exporter, err = otlptracegrpc.New(ctx, otlptracegrpc.WithEndpointURL(traces))
		}
		if err == nil && exporter != nil {
			tp = sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(exporter))
			otel.SetTracerProvider(tp)
		}
	}
	if metrics != "" {
		var exporter sdkmetric.Exporter
		var err error
		switch metricProtocol {
		case "http/protobuf":
			exporter, err = otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(metrics))
		case "grpc":
			exporter, err = otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithEndpointURL(metrics))
		}
		if err == nil && exporter != nil {
			mp = sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)))
			otel.SetMeterProvider(mp)
		}
	}
	return func() {
		// Run both flushes independently; an unavailable signal must not block the other.
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		done := make(chan struct{})
		go func() {
			defer close(done)
			if mp != nil {
				_ = mp.Shutdown(ctx)
			}
		}()
		if tp != nil {
			_ = tp.Shutdown(ctx)
		}
		<-done
	}
}
