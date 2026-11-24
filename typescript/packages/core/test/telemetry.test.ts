import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { context, metrics, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { Harness, type ToolSource } from "@modular-agent/harness";
import { currentSpan, readTrace, startOperation, withTrace } from "@modular-agent/harness/telemetry";
import { registerExternalPlugin, servePlugins, WirePeer } from "@modular-agent/plugin-wire";
import { definePlugin, fileHistory, tool } from "../src/index.js";
import { testAgent } from "../src/testing.js";
import { waitingAgent } from "./fixtures/waiting-approval.js";

function record(t: TestContext, failing = false) {
  const exporter = new InMemorySpanExporter();
  const attempts: number[] = [];
  const processor = new SimpleSpanProcessor({ exporter: failing ? {
    export(_items, done) { attempts.push(1); done({ code: 1, error: new Error("EXPORT_ERROR_SENTINEL") }); },
    async shutdown() {},
  } : exporter });
  const provider = new TracerProvider({ spanProcessors: [processor] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  t.after(async () => { await provider.shutdown(); trace.disable(); context.disable(); });
  return { spans: () => exporter.getFinishedSpans(), attempts, provider };
}

const parent = (span: ReadableSpan) => span.parentSpanContext?.spanId;
const id = (span: ReadableSpan) => span.spanContext().spanId;
const remoteContext = { traceparent: "00-12345678901234567890123456789012-1234567890123456-01", baggage: "private=DO_NOT_EXPORT" };

test("waiting approval ends its opening spans and links actual dispatch to a new turn", async t => {
  const { spans } = record(t);
  const dir = await mkdtemp(join(tmpdir(),"ma-trace-approval-"));
  const agent = await waitingAgent(dir,false);
  t.after(async () => { await agent.close(); await rm(dir,{recursive:true,force:true}); });
  const session = await agent.session();
  const origin = await session.prompt("TRACE_PRIVATE_INPUT");
  await session.waitIdle();
  const [q] = await session.questions({present:true});
  const opened = spans().find(s => s.events.some(e => e.name === "modular_agent.question.open" && e.attributes?.["modular_agent.question.id"] === q.id));
  const originSpan = spans().find(s => s.name === "invoke_agent" && s.attributes["modular_agent.turn.id"] === origin.turnId);
  assert.ok(opened && originSpan); assert.equal(opened.name,"modular_agent.step"); assert.equal(parent(opened),id(originSpan));
  assert.ok(!spans().some(s => s.name.startsWith("execute_tool")));
  await session.answer(q.id,"allow"); await session.waitIdle();
  const close = spans().find(s=>s.events.some(e=>e.name === "modular_agent.question.close" && e.attributes?.["modular_agent.question.id"]===q.id));
  assert.equal(close?.name,"modular_agent.question.answer");
  const next = spans().find(s => s.name === "invoke_agent" && s.links.some(l => l.context.spanId === id(originSpan)));
  assert.ok(next); assert.notEqual(next.attributes["modular_agent.turn.id"],origin.turnId);
  const tool = spans().filter(s=>s.name==="execute_tool bump");
  assert.equal(tool.length,1); assert.equal(tool[0].attributes["modular_agent.turn.id"],next.attributes["modular_agent.turn.id"]);
  assert.equal(tool[0].attributes["modular_agent.tool.call.id"],origin.openToolCalls[0]);
  assert.doesNotMatch(JSON.stringify(spans().map(s=>[s.name,s.attributes,s.events])),/TRACE_PRIVATE_INPUT|approvalView|Allow bump|sdk\.local/);
});

// No provider registration: even a trusted incoming parent is not a turn span.
test("telemetry support does not require an installed OpenTelemetry SDK", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ma-trace-no-sdk-"));
  const a = await testAgent({ dataDir: dir, durability: "durable", script: [{ text: "ready" }] });
  t.after(async () => { await a.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(a.declaration().telemetry, 1);
  const s = await a.session();
  assert.equal((await withTrace(readTrace(remoteContext), () => s.prompt("one"))).text, "ready");
  assert.equal((await s.history()).some(e => JSON.stringify(e.data)?.includes("traceContext")), false);
});

test("the Harness exports metadata, parentage, nested work and one metric per inference", async t => {
  const { spans, provider } = record(t);
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter });
  const meter = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(meter);
  t.after(async () => { await meter.shutdown(); metrics.disable(); });
  let nestedCalls = 0;
  const a = await testAgent({ agentName: "fixture", onQuestion: () => ({ value: "ANSWER_SENTINEL" }),
    plugins: [definePlugin({ name: "gate", setup(r) { r.on("tool.before", ({ call }) => call.name === "deny" ? { refuse: "REFUSAL_SENTINEL" } : undefined); } })],
    tools: [
      tool({ name: "outer", description: "DEFINITION_SENTINEL", input: { type: "object" }, async run(_, cx) {
        await cx.ask({ kind: "text", question: "QUESTION_SENTINEL" });
        const job = await cx.jobs.start("lookup", { secret: "JOB_SENTINEL" }, "job-key");
        assert.equal((await cx.jobs.start("lookup", {}, "job-key")).started, false);
        await job.end({ kind: "completed" }, "REPORT_SENTINEL", true);
        await Promise.all([cx.tools.call("inner", {}), cx.tools.call("inner", {})]);
        return "TOOL_RESULT_SENTINEL";
      } }),
      tool({ name: "inner", description: "A nested tool", input: { type: "object" }, run() { nestedCalls++; return "RESULT_SENTINEL"; } }),
      tool({ name: "deny", description: "Never runs", input: { type: "object" }, run() { assert.fail("denied tool ran"); } }),
    ],
    script: [{ text: "MODEL_TEXT_SENTINEL", reasoning: "REASONING_SENTINEL", usage: { input: 7, cacheRead: 11, cacheWrite: 13, output: 3 }, toolCalls: [
      { name: "outer", input: { data: "ARGUMENT_SENTINEL" } }, { name: "deny", input: {} },
    ] }, { text: "done" }],
  });
  t.after(() => a.close());
  const s = await a.session();
  assert.equal((await withTrace(readTrace(remoteContext), () => s.prompt("PROMPT_SENTINEL"))).text, "done");
  await s.waitIdle();
  await s.close();
  await provider.forceFlush();
  await meter.forceFlush();
  assert.equal(nestedCalls, 2);
  const all = spans();
  const byName = (name: string) => all.filter(s => s.name === name);
  const [turn] = byName("invoke_agent fixture"), [input] = byName("modular_agent.input.admit");
  assert.equal(parent(input), "1234567890123456");
  assert.equal(parent(turn), id(input));
  assert.equal(turn.spanContext().traceId, readTrace(remoteContext)?.traceId);
  assert.equal(turn.attributes["modular_agent.turn.outcome"], "completed");
  assert.equal(turn.attributes["gen_ai.agent.name"], "fixture");
  const steps = byName("modular_agent.step");
  assert.equal(steps.length, 2);
  assert.ok(steps.every(x => parent(x) === id(turn) && x.attributes["modular_agent.step.id"]));
  const chats = byName("chat script");
  assert.equal(chats.length, 2);
  assert.ok(chats.every(x => steps.some(step => parent(x) === id(step)) && x.kind === SpanKind.INTERNAL && x.attributes["gen_ai.provider.name"] === "scripted"));
  const usage = (x: ReadableSpan) => Object.fromEntries(Object.entries(x.attributes).filter(([k]) => k.startsWith("gen_ai.usage.")));
  assert.deepEqual(usage(chats[0]), {
    "gen_ai.usage.input_tokens": 31,
    "gen_ai.usage.cache_read.input_tokens": 11,
    "gen_ai.usage.cache_write.input_tokens": 13,
    "gen_ai.usage.output_tokens": 3,
  });
  assert.deepEqual(usage(chats[1]), {});
  const [outer] = byName("execute_tool outer"), children = byName("execute_tool inner");
  assert.ok(steps.some(x => id(x) === parent(outer)));
  assert.equal(outer.attributes["gen_ai.tool.call.id"], "call-0-0");
  assert.equal(children.length, 2);
  for (const x of children) {
    assert.equal(parent(x), id(outer));
    assert.equal(x.attributes["modular_agent.tool.parent_call.id"], "call-0-0");
    assert.equal(x.attributes["modular_agent.tool.status"], "completed");
    assert.equal(x.attributes["gen_ai.tool.call.id"], undefined);
  }
  assert.notEqual(id(children[0]), id(children[1]));
  const [job] = byName("modular_agent.job");
  assert.equal(byName("modular_agent.job").length, 1);
  assert.equal(parent(job), id(outer));
  assert.equal(job.attributes["modular_agent.job.outcome"], "completed");
  assert.ok(byName("modular_agent.input.admit").some(x => x.links.some(l => l.context.spanId === id(job))));
  const events = all.flatMap(x => x.events);
  const opened = events.find(x => x.name === "modular_agent.question.open");
  const closed = events.find(x => x.name === "modular_agent.question.close");
  assert.equal(opened?.attributes?.["modular_agent.question.kind"], "text");
  assert.equal(closed?.attributes?.["modular_agent.question.id"], opened?.attributes?.["modular_agent.question.id"]);
  assert.equal(closed?.attributes?.["modular_agent.question.disposition"], "answered");
  assert.equal(byName("execute_tool deny").length, 0);
  assert.ok(events.some(x => x.name === "modular_agent.tool.disposition" && x.attributes?.["modular_agent.tool.status"] === "refused"));
  assert.ok(byName("modular_agent.history.commit").some(x => parent(x) === id(turn) && x.attributes["modular_agent.history.commit.status"] === "committed"));
  assert.equal(byName("modular_agent.session.open")[0].attributes["modular_agent.session.operation"], "new");
  assert.equal(byName("modular_agent.session.close")[0].attributes["modular_agent.session.operation"], "close");
  assert.ok(all.every(x => x.attributes["gen_ai.conversation.id"] === s.id));
  const points = exporter.getMetrics().at(-1)!.scopeMetrics.flatMap(x => x.metrics);
  const point = (name: string) => points.find(x => x.descriptor.name === `gen_ai.client.inference.${name}`)!.dataPoints[0];
  assert.equal((point("duration").value as { count: number }).count, 2);
  assert.equal(point("usage.input_tokens").value, 31);
  assert.equal(point("usage.output_tokens").value, 3);
  assert.equal(point("usage.input_tokens").attributes["gen_ai.token.modality"], "unknown");
  const exported = JSON.stringify(all.map(x => ({ name: x.name, attributes: x.attributes, resource: x.resource.attributes,
    status: x.status, events: x.events, links: x.links, context: x.spanContext(), parent: x.parentSpanContext })));
  assert.doesNotMatch(exported, /SENTINEL|DO_NOT_EXPORT|baggage/);
  assert.doesNotMatch(JSON.stringify(points), /SENTINEL|DO_NOT_EXPORT|baggage/);
});

test("model diagnostics are bounded and a failed exporter does not alter work", async t => {
  const { attempts, provider } = record(t, true);
  let ran = 0;
  const a = await testAgent({ tools: [tool({ name: "once", description: "Run once", input: { type: "object" }, run() { ran++; return "ok"; } })],
    script: [{ toolCalls: [{ name: "once", input: {} }] }, { text: "settled" }] });
  t.after(() => a.close());
  const s = await a.session();
  assert.equal((await s.prompt("work")).outcome?.kind, "completed");
  await s.waitIdle();
  await provider.forceFlush();
  assert.equal((await s.history()).filter(x => x.kind === "turnEnd").length, 1);
  assert.equal(ran, 1);
  assert.ok(attempts.length > 0);
});

for (const [offer, accept] of [[true, true], [true, false], [false, true]]) {
  test(`plugin work context: offer=${offer}, accept=${accept}`, async t => {
    const { spans, provider } = record(t);
    const harness = new Harness({ project: "/", home: "/" });
    const sessionId = await harness.startSession();
    const input = new PassThrough();
    const toPlugin: any[] = [], toHost: any[] = [];
    const host = new WirePeer(line => { toPlugin.push(JSON.parse(line)); queueMicrotask(() => input.write(line)); });
    const done = servePlugins({ name: "fixture", acceptTraceContext: accept, input, output: line => {
      toHost.push(JSON.parse(line)); queueMicrotask(() => host.feed(line));
    }, plugins: [{ name: "fixture", setup(api) {
      api.provide("tool-source", {
        id: "fixture-tools", tools: () => [{ name: "ask", description: "Ask", parameters: { type: "object" } }],
        async run(call, ctx) { await ctx.ask({ kind: "text", question: "WIRE_SENTINEL" }); return { callId: call.id, status: "completed", content: [] }; },
      } satisfies ToolSource);
    } }] });
    t.after(async () => { await harness.stop(); input.end(); await done; });
    const external = await registerExternalPlugin(host, { project: "/", home: "/" }, {}, async () => {}, undefined, offer);
    await harness.load([external.plugin]);
    const source = harness.use<ToolSource>("tool-source")!;
    const op = startOperation("test.operation", { "gen_ai.conversation.id": sessionId });
    const call = { id: "test-call", name: "ask", input: {}, startedBy: "plugin" as const };
    await op.observe(async () => {
      const result = await source.run(call, { call, sessionId, signal: new AbortController().signal,
        async ask() { assert.ok(currentSpan()); return { requestId: "fixture-answer", declined: true, actorId: "user" }; }, progress() {}, jobs: { async start() { throw new Error("not used"); } } });
      assert.ok("status" in result && result.status === "completed");
    });
    const agreed = offer && accept;
    assert.equal(toPlugin.find(m => m.method === "plugin/initialize").params.traceContext, offer ? 1 : undefined);
    assert.equal(toHost.find(m => m.result?.binding).result.traceContext, agreed ? 1 : undefined);
    assert.equal(!!toPlugin.find(m => m.method === "tools/call").params.traceContext, agreed);
    assert.equal(!!toHost.find(m => m.method === "host/ask").params.traceContext, agreed);
    assert.ok([...toPlugin, ...toHost].filter(m => !m.method && !m.result?.binding).every(m => !JSON.stringify(m).includes("traceContext")));
    await provider.forceFlush();
    const client = spans().find(s => s.kind === SpanKind.CLIENT && s.attributes["modular_agent.plugin.method"] === "tools/call")!;
    const server = spans().find(s => s.kind === SpanKind.SERVER && s.attributes["modular_agent.plugin.method"] === "tools/call")!;
    assert.equal(parent(client), op.spanContext?.spanId);
    assert.equal(parent(server), agreed ? id(client) : undefined);
    const callback = spans().find(s => s.kind === SpanKind.SERVER && s.attributes["modular_agent.plugin.method"] === "host/ask")!;
    assert.equal(callback.spanContext().traceId, client.spanContext().traceId);
    assert.doesNotMatch(JSON.stringify(spans().map(s => [s.name, s.attributes, s.status, s.events])), /WIRE_SENTINEL/);
  });
}

test("restart after SIGKILL uses the committed trace and does not repeat the effect", { timeout: 15_000 }, async t => {
  const { spans, provider } = record(t);
  const dir = await mkdtemp(join(tmpdir(), "ma-trace-crash-"));
  const child = fork(fileURLToPath(new URL("./fixtures/telemetry-crash.js", import.meta.url)), [dir], {
    env: { HOME: dir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); });
  const exited = once(child, "exit");
  const [{ sessionId, turnId, traceContext }] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error("crash fixture exited before barrier"); })]);
  const saved = readTrace(traceContext)!;
  assert.ok(saved);
  child.kill("SIGKILL");
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  const a = await testAgent({ project: dir, dataDir: dir, durability: "durable", history: fileHistory(join(dir, "history")), script: [{ text: "not requested" }],
    tools: [tool({ name: "barrier", description: "Must not run again", input: { type: "object" }, run() { assert.fail("effect was repeated"); } })],
  });
  try {
    const s = await a.openSession(sessionId);
    await s.waitIdle();
    await provider.forceFlush();
    const resumed = spans().find(s => s.attributes["modular_agent.turn.resumed"] === true)!;
    assert.equal(resumed.attributes["modular_agent.turn.id"], turnId);
    assert.equal(resumed.spanContext().traceId, saved.traceId);
    assert.notEqual(id(resumed), saved.spanId);
    assert.equal(parent(resumed), saved.spanId);
    assert.deepEqual(resumed.links.map(x => x.context.spanId), [saved.spanId]);
    const history = await s.history();
    const checkpoint = history.findIndex(e => e.kind === "modular-agent.turnTrace");
    assert.equal(readTrace((history[checkpoint].data as { traceContext: unknown }).traceContext)?.spanId, id(resumed));
    assert.ok(checkpoint < history.findIndex(e => e.kind === "toolResult"));
    assert.equal(await readFile(join(dir, "effect"), "utf8"), "once");
    const copied = await (await s.fork()).history();
    assert.ok(copied.some(e => e.kind === "turnStart"));
    assert.ok(copied.every(e => e.kind !== "modular-agent.turnTrace" && !JSON.stringify(e.data)?.includes("traceContext")));
  } finally { await a.close(); }
});
