import assert from "node:assert/strict";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { createAgent } from "@modular-agent/core";
import { memoryEnvironment } from "@modular-agent/core/testing";
import { chatgpt, grok } from "@modular-agent/subscription";
import { body, fixture, loginFile } from "./fixtures.js";

const cases = [
  { meter: { input_tokens: 1000, output_tokens: 2, input_tokens_details: { cached_tokens: 700 } }, input: 300, cacheRead: 700, total: 1000 },
  { meter: { input_tokens: 1000, output_tokens: 2 }, input: 1000, cacheRead: 0, total: 1000 },
  { meter: { input_tokens: 1000, output_tokens: 2, input_tokens_details: { cached_tokens: 1200 } }, input: 0, cacheRead: 1200, total: 1200 },
  { meter: undefined },
];

for (const [make, id, model] of [[chatgpt, "chatgpt", "gpt-6.1-sol"], [grok, "grok", "grok-4.3"]] as const) {
  test(`${id} Responses usage keeps cached input separate in messages and telemetry`, async t => {
    const exporter = new InMemorySpanExporter();
    const tracer = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    trace.setGlobalTracerProvider(tracer);
    t.after(async () => { await tracer.shutdown(); trace.disable(); });
    const logins = await loginFile(t);
    await logins.setLogin(id, { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 60_000,
      ...(id === "chatgpt" && { account: "fixture-account" }) });
    let request = 0;
    const server = await fixture(t, async (req, res) => {
      await body(req);
      const { meter } = cases[request++];
      const output = [{ type: "message", content: [{ type: "output_text", text: "hello" }] }];
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: { output, usage: meter } })}\n\n`);
    });
    const provider = make({ logins, test: { endpoint: server.url } });
    const agent = await createAgent({ providers: [provider], model: `${id}/${model}`, environment: memoryEnvironment() });
    t.after(() => agent.close());
    for (const { meter, input, cacheRead, total } of cases) {
      exporter.reset();
      const session = await agent.session();
      assert.equal((await session.prompt("check usage")).text, "hello");
      const reply = (await session.history()).find(entry => entry.kind === "response")?.message;
      assert.equal(reply?.role, "assistant");
      assert.deepEqual(reply.usage, meter ? { input, cacheRead, cacheWrite: 0, output: 2, cost: 0 } : undefined);
      const chats = exporter.getFinishedSpans().filter(span => span.name === `chat ${model}`);
      assert.equal(chats.length, 1);
      const attributes = Object.fromEntries(Object.entries(chats[0].attributes).filter(([key]) => key.startsWith("gen_ai.usage.")));
      assert.deepEqual(attributes, meter ? {
        "gen_ai.usage.input_tokens": total,
        "gen_ai.usage.output_tokens": 2,
        ...(cacheRead && { "gen_ai.usage.cache_read.input_tokens": cacheRead }),
      } : {});
    }
  });
}
