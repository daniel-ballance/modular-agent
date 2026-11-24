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
  const active = new Map<string, {name:string; sessionId:unknown}>();
  const provider = new TracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [{
    onStart(span) { active.set(span.spanContext().spanId, {name:span.name, sessionId:span.attributes["gen_ai.conversation.id"]}); },
    onEnd(span) { active.delete(span.spanContext().spanId); },
    async forceFlush() {}, async shutdown() {},
  }, new BatchSpanProcessor({ exporter })] });
  const manager = new AsyncLocalStorageContextManager().enable();
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
  return Object.assign(async () => {
    try { await provider.forceFlush(); }
    finally {
      try { await provider.shutdown(); }
      finally { manager.disable(); }
    }
  }, { flush: () => provider.forceFlush(), activeWork: (id: string) => [...active.values()].filter(s => s.sessionId === id &&
    /^(invoke_agent|execute_tool|modular_agent\.(step|question\.|job))/.test(s.name)).map(s=>s.name) });
}
