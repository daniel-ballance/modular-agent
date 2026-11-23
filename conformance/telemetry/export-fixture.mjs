import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import { OTLPTraceExporter as ProtobufExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPTraceExporter as JsonExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const [encoding, url] = process.argv.slice(2);
const Exporter = encoding === "protobuf" ? ProtobufExporter : JsonExporter;
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": `fixture-${encoding}` }),
  sampler: new AlwaysOnSampler(),
  spanProcessors: [new BatchSpanProcessor(new Exporter({ url }))],
});
const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const saved = { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true };
const span = provider.getTracer("receiver-test", "1.0.0").startSpan("fixture span", {
  kind: SpanKind.CLIENT,
  attributes: { "fixture.count": 7, "fixture.present": true },
  links: [{ context: saved, attributes: { "fixture.link": "saved" } }],
}, trace.setSpanContext(ROOT_CONTEXT, saved));
span.addEvent("fixture event", { "fixture.answer": "synthetic" });
span.end();
await provider.forceFlush();
await provider.shutdown();
