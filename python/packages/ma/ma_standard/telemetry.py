"""Configure OTLP for ma. The SDK library does not install providers."""

from collections.abc import Iterator
from contextlib import ExitStack, contextmanager, suppress
from dataclasses import dataclass
import logging
import math
import os

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricExporter, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter


@dataclass(frozen=True)
class Signal:
    endpoint: str
    protocol: str
    timeout: float


def signal_options(signal: str) -> Signal | None:
    def setting(suffix: str) -> str | None:
        return os.environ.get(f"OTEL_EXPORTER_OTLP_{signal.upper()}_{suffix}") or os.environ.get(
            f"OTEL_EXPORTER_OTLP_{suffix}"
        )

    endpoint = setting("ENDPOINT")
    if not endpoint:
        return None
    protocol = setting("PROTOCOL") or "http/protobuf"
    if protocol not in {"http/protobuf", "grpc"}:
        raise ValueError("unsupported OTLP protocol; use http/protobuf or grpc")
    if protocol == "http/protobuf" and not os.environ.get(
        f"OTEL_EXPORTER_OTLP_{signal.upper()}_ENDPOINT"
    ):
        endpoint = endpoint.rstrip("/") + "/v1/" + signal
    # OTLP environment values are milliseconds, but these Python constructors
    # take seconds. See https://opentelemetry.io/docs/specs/otel/protocol/exporter/#configuration-options
    try:
        timeout = float(setting("TIMEOUT") or 10000) / 1000
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError
    except ValueError:
        timeout = 10.0
    return Signal(endpoint, protocol, timeout)


def trace_exporter(options: Signal) -> SpanExporter:
    if options.protocol == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

        return OTLPSpanExporter(endpoint=options.endpoint, timeout=options.timeout)
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter as HttpSpans

    return HttpSpans(endpoint=options.endpoint, timeout=options.timeout)


def metric_exporter(options: Signal) -> MetricExporter:
    if options.protocol == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

        return OTLPMetricExporter(endpoint=options.endpoint, timeout=options.timeout)
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
        OTLPMetricExporter as HttpMetrics,
    )

    return HttpMetrics(endpoint=options.endpoint, timeout=options.timeout)


def _quiet_exporters(stack: ExitStack) -> None:
    # Some exporter diagnostics carry the collector's response or an invalid
    # header value. Those diagnostics must not reveal launch credentials.
    prefixes = ("opentelemetry.exporter.", "opentelemetry.util.re", "urllib3.", "grpc.")
    for name in (
        "opentelemetry.util.re",
        "opentelemetry.exporter.otlp.proto.grpc.exporter",
        "opentelemetry.exporter.otlp.proto.http._common",
        "opentelemetry.exporter.otlp.proto.http.trace_exporter",
        "opentelemetry.exporter.otlp.proto.http.metric_exporter",
        "opentelemetry.exporter.otlp.proto.http._common._exporter",
        "urllib3.connectionpool",
    ):
        logging.getLogger(name)
    for name in list(logging.Logger.manager.loggerDict):
        if any(name.startswith(p.removesuffix(".")) for p in prefixes):
            logger = logging.getLogger(name)
            old = logger.level
            logger.setLevel(logging.CRITICAL + 1)
            stack.callback(logger.setLevel, old)


def _finish(provider: TracerProvider | MeterProvider) -> None:
    with suppress(Exception):
        provider.shutdown()


@contextmanager
def configured() -> Iterator[None]:
    if os.environ.get("OTEL_SDK_DISABLED", "").lower() == "true":
        yield
        return
    traces = signal_options("traces")
    usage = signal_options("metrics")
    if traces is None and usage is None:
        yield
        return
    resource = Resource({"service.name": os.environ.get("OTEL_SERVICE_NAME") or "ma"})
    with ExitStack() as lifetime:
        # Load only the selected exporters. SDK defaults handle sampling and the
        # official exporters handle the per-signal headers and TLS settings.
        _quiet_exporters(lifetime)
        if traces:
            with suppress(Exception):
                exporter = trace_exporter(traces)
                provider = TracerProvider(resource=resource, shutdown_on_exit=False)
                lifetime.callback(_finish, provider)
                provider.add_span_processor(BatchSpanProcessor(exporter))
                trace.set_tracer_provider(provider)
        if usage:
            with suppress(Exception):
                reader = PeriodicExportingMetricReader(metric_exporter(usage))
                meter = MeterProvider(
                    resource=resource, metric_readers=[reader], shutdown_on_exit=False
                )
                lifetime.callback(_finish, meter)
                metrics.set_meter_provider(meter)
        yield
