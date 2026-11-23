import { ROOT_CONTEXT, trace, type SpanContext } from '@opentelemetry/api';
import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

let provider: TracerProvider | undefined;
export function startTracing() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || process.env.OTEL_SDK_DISABLED === 'true') return;
  const exporter = new OTLPTraceExporter({url: endpoint.replace(/\/$/,'')+'/v1/traces'});
  provider = new TracerProvider({spanProcessors:[new BatchSpanProcessor({exporter})]});
  trace.setGlobalTracerProvider(provider);
}
export function stopTracing() { return provider?.shutdown(); }
export function operation(name: string, parent?: string | null) {
  let context = ROOT_CONTEXT;
  if (parent) {
    const [,traceId,spanId,flags] = parent.split('-');
    const sc: SpanContext = {traceId,spanId,traceFlags:parseInt(flags,16),isRemote:true};
    context = trace.setSpanContext(context,sc);
  }
  const span = trace.getTracer('ops-desk').startSpan(name,{},context);
  const sc = span.spanContext();
  const header = trace.isSpanContextValid(sc) ? `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2,'0')}` : null;
  return {header,end:()=>span.end()};
}
