package fixtures

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

const EndpointEnv = "MODULAR_AGENT_TELEMETRY_OTLP"

// InstallTelemetry is used only by the shared scenario runner and fixture programs.
func InstallTelemetry(ctx context.Context, endpoint string) (func() error, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || !net.ParseIP(u.Hostname()).IsLoopback() || u.Port() == "" || u.Path != "/v1/traces" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("telemetry fixture needs a numeric loopback HTTP trace endpoint")
	}
	httpClient := &http.Client{Transport: &http.Transport{}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	client, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint), otlptracehttp.WithHTTPClient(httpClient), otlptracehttp.WithHeaders(map[string]string{}), otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}))
	if err != nil {
		return nil, err
	}
	// BatchSpanProcessor sends export errors to the global error handler, not
	// to ForceFlush. Keep them so a failed export cannot count as success.
	errs := &exportErrors{SpanExporter: client}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(errs), sdktrace.WithSampler(sdktrace.AlwaysSample()))
	otel.SetTracerProvider(tp)
	return func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := errors.Join(tp.ForceFlush(ctx), tp.Shutdown(ctx))
		httpClient.CloseIdleConnections()
		errs.mu.Lock()
		defer errs.mu.Unlock()
		return errors.Join(err, errs.err)
	}, nil
}

type exportErrors struct {
	sdktrace.SpanExporter
	mu  sync.Mutex
	err error
}

func (e *exportErrors) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	err := e.SpanExporter.ExportSpans(ctx, spans)
	if err != nil {
		e.mu.Lock()
		e.err = errors.Join(e.err, err)
		e.mu.Unlock()
	}
	return err
}
