import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { AlwaysOnSampler, BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

// Only the fixture and scenario entry points install an SDK.
export function startTelemetry(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/v1/traces" || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected a loopback OTLP/HTTP traces endpoint");
  }
  const exporter = new OTLPTraceExporter({ url: url.href });
  const provider = new TracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new BatchSpanProcessor({ exporter })] });
  const manager = new AsyncLocalStorageContextManager().enable();
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
  return async () => {
    try { await provider.forceFlush(); }
    finally {
      try { await provider.shutdown(); }
      finally { manager.disable(); }
    }
  };
}
