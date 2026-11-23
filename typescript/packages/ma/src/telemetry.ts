import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AlwaysOffSampler, AlwaysOnSampler, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, TracerProvider } from "@opentelemetry/sdk-trace";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";

function setting(name: string): string | undefined { return process.env[name] || undefined; }

function sampler() {
  const arg = setting("OTEL_TRACES_SAMPLER_ARG");
  const n = arg === undefined || !arg.trim() ? 1 : Number(arg);
  const ratio = new TraceIdRatioBasedSampler(Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1);
  switch (setting("OTEL_TRACES_SAMPLER")) {
    case "always_on": return new AlwaysOnSampler();
    case "always_off": return new AlwaysOffSampler();
    case "traceidratio": return ratio;
    case "parentbased_traceidratio": return new ParentBasedSampler({ root: ratio });
    case "parentbased_always_off": return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    default: return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

function exporterOptions(signal: "traces" | "metrics") {
  const prefix = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}`;
  const specific = setting(`${prefix}_ENDPOINT`);
  const endpoint = specific ?? setting("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (!endpoint) return;
  const protocol = setting(`${prefix}_PROTOCOL`) ?? setting("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "http/protobuf";
  if (protocol !== "http/protobuf" && protocol !== "grpc") return;
  let url = endpoint;
  if (protocol === "http/protobuf") {
    const target = new URL(endpoint);
    if (target.protocol !== "http:" && target.protocol !== "https:") return;
    if (!specific) target.pathname = `${target.pathname.replace(/\/$/, "")}/v1/${signal}`;
    url = target.toString();
  }
  // The official exporters apply the standard per-signal header and timeout
  // environment settings. Supply an explicit URL so they cannot use a default.
  return { protocol, url };
}

/** Only ma installs providers. Do not even load exporters unless configured. */
export async function startTelemetry(): Promise<() => Promise<void>> {
  const stop: (() => Promise<void>)[] = [];
  const shutdown = async () => { await Promise.allSettled(stop.map(close => close())); };
  if (setting("OTEL_SDK_DISABLED")?.toLowerCase() === "true") return shutdown;
  const resource = resourceFromAttributes({ "service.name": setting("OTEL_SERVICE_NAME") ?? "ma" });
  try {
    const options = exporterOptions("traces");
    if (options) {
      const { OTLPTraceExporter } = options.protocol === "grpc" ? await import("@opentelemetry/exporter-trace-otlp-grpc")
        : await import("@opentelemetry/exporter-trace-otlp-proto");
      const exporter = new OTLPTraceExporter({ url: options.url });
      const provider = new TracerProvider({ resource, sampler: sampler(), spanProcessors: [new BatchSpanProcessor({ exporter })] });
      const manager = new AsyncLocalStorageContextManager().enable();
      trace.setGlobalTracerProvider(provider);
      context.setGlobalContextManager(manager);
      stop.push(async () => { try { await provider.shutdown(); } finally { manager.disable(); } });
    }
  } catch { /* An invalid exporter configuration must not affect work. */ }
  try {
    const options = exporterOptions("metrics");
    if (options) {
      const { OTLPMetricExporter } = options.protocol === "grpc" ? await import("@opentelemetry/exporter-metrics-otlp-grpc")
        : await import("@opentelemetry/exporter-metrics-otlp-proto");
      const exporter = new OTLPMetricExporter({ url: options.url });
      const reader = new PeriodicExportingMetricReader({ exporter });
      const provider = new MeterProvider({ resource, readers: [reader] });
      metrics.setGlobalMeterProvider(provider);
      stop.push(async () => { try { await provider.forceFlush(); } finally { await provider.shutdown(); } });
    }
  } catch { /* Do not report endpoint, headers or other exporter diagnostics. */ }
  return shutdown;
}
