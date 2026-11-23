// Print the loopback origin on startup. After the desk shuts down, EOF asks
// for the event and invocation IDs. Keep payloads inside the test receiver.
import { startReceiver } from '../../../conformance/telemetry/receiver.mjs';

const receiver = await startReceiver();
try {
  console.log(new URL(receiver.endpoint).origin);
  for await (const _ of process.stdin) { /* wait for EOF */ }
} finally {
  await receiver.close();
}
const { errors, payloads } = receiver.snapshot();
if (errors.length) throw Error(errors.join('; '));
const attr = (item, key) => item.attributes?.find(a => a.key === key)?.value?.stringValue;
const events = [], invocations = [];
for (const batch of payloads) {
  for (const { resource, scopeSpans } of batch.resourceSpans ?? []) {
    for (const scope of scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        if (span.name === 'desk.event') events.push(span.traceId);
        if (attr(span, 'gen_ai.operation.name') === 'invoke_agent') {
          invocations.push({ service: attr(resource, 'service.name'), trace: span.traceId });
        }
      }
    }
  }
}
console.log(JSON.stringify({ events, invocations }));
