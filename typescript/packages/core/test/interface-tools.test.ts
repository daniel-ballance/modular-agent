import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { createAgent, definePlugin, tool, transientRuntime, type AgentOptions, type InterfaceToolConnection, type InterfaceToolConnectionOptions, type InterfaceToolHandoff, type InterfaceToolReport } from "../src/index.js";
import { memoryEnvironment, scriptedProvider, testResources } from "../src/testing.js";
import { pick, picker, provider, remoteRuntime, requested, source } from "./fixtures/interface-tools.js";

const completed = { status: "accepted" };
const refused = { status: "refused" };
const report = (callId: string, value: unknown = "blue"): InterfaceToolReport => ({ callId, status: "completed", content: [{ type: "text", text: "REPORT_MARKER" }], value });
const checked = definePlugin({ name: "check.color", setup(r) {
  r.on("tool.after", ({ result }) => result.status === "completed" ? { change: { content: [{ type: "text", text: "checked color" }] } } : undefined);
} });
const options = (remote: boolean, extra: AgentOptions = {}): AgentOptions => ({ severalActors: true, environment: memoryEnvironment(),
  interfaceTools: [source], providers: [provider()], ...(remote ? { processPlugins: [remoteRuntime()] } : {}), ...extra });

async function fixture(t: TestContext, remote: boolean, extra: AgentOptions = {}, defer = false) {
  const agent = await createAgent(options(remote, extra));
  t.after(() => agent.close());
  const session = await agent.session({ actors: [picker] });
  const handoffs: InterfaceToolHandoff[] = [];
  const connect = (actor = picker, routeId = source.routeId) => agent.connectInterfaceTools(session.id, { actor, routeId, defer,
    onHandoff: h => { handoffs.push(h); } });
  const conn = connect();
  conn.advertise([pick]);
  return { agent, session, conn, connect, handoffs };
}

test("the public Interface tool handle exposes only the documented methods and ignores callback returns", async t => {
  const agent = await createAgent(options(false));
  t.after(() => agent.close());
  const session = await agent.session({ actors: [picker] });
  const handoffs: InterfaceToolHandoff[] = [];
  const onHandoff: InterfaceToolConnectionOptions["onHandoff"] = request => {
    handoffs.push(request);
    return "withheld"; // TypeScript permits a value from a callback whose result is ignored.
  };
  const connection = agent.connectInterfaceTools(session.id, { actor: picker, routeId: source.routeId, onHandoff });
  const methods: Record<keyof InterfaceToolConnection, true> = {
    advertise: true, release: true, reportInterfaceToolResult: true, disconnect: true,
  };
  assert.deepEqual(Object.keys(connection).sort(), Object.keys(methods).sort());
  const returnsVoid: ReturnType<InterfaceToolConnectionOptions["onHandoff"]> extends void ? true : false = true;
  assert.ok(returnsVoid);
  connection.advertise([pick]);
  const turn = await session.prompt("Pick.");
  assert.deepEqual(turn.openToolCalls, handoffs.map(h => h.call.id));
  assert.equal(handoffs.length, 1);
  assert.deepEqual(await connection.reportInterfaceToolResult(report(handoffs[0].call.id)), completed);
  await session.waitIdle();
});

for (const remote of [false, true]) {
  const placement = remote ? "remote Runtime" : "embedded Runtime";
  test(`${placement}: same-route reconnect settles the race once and continues from the checked result`, async t => {
    const other = { ...source, sourceId: "other", routeId: "other", tools: [{ ...pick, name: "other_tool" }] };
    const seen: string[] = [];
    const observing = provider();
    const request = observing.request.bind(observing);
    observing.request = (model, input, cx) => { seen.push(JSON.stringify(input.messages)); return request(model, input, cx); };
    const { agent, session, conn, connect, handoffs } = await fixture(t, remote,
      { interfaceTools: [source, other], plugins: [checked], providers: [observing] });
    assert.equal(agent.declaration().interfaceTools, true);
    const origin = await session.prompt("Pick.");
    const [id] = origin.openToolCalls;
    assert.ok(id);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].call.id, id);
    assert.equal((await session.history()).some(e => e.kind === "toolPending"), false);
    assert.doesNotMatch(JSON.stringify(await session.history()), /executorActorId|routeId/);
    conn.disconnect();
    assert.deepEqual(await conn.reportInterfaceToolResult(report(id)), refused);
    assert.deepEqual(await connect(picker, other.routeId).reportInterfaceToolResult(report(id)), refused);
    assert.deepEqual(await connect({ ...picker, rights: ["watch"] }).reportInterfaceToolResult(report(id)), refused);
    const a = connect(), b = connect();
    assert.deepEqual(await Promise.all([a.reportInterfaceToolResult(report(id)), b.reportInterfaceToolResult(report(id, "green"))]),
      [completed, { status: "alreadySettled" }]);
    await session.waitIdle();
    assert.equal((await session.lastTurn())?.text, "Continued.");
    const history = await session.history();
    const starts = history.filter(e => e.kind === "toolStarted");
    const [result] = history.filter(e => e.kind === "toolResult");
    assert.equal(starts.length, 1);
    assert.equal(history.filter(e => e.kind === "toolResult").length, 1);
    assert.equal(result.actorId, picker.id);
    assert.equal(result.turnId, origin.turnId);
    assert.equal(result.stepId, starts[0].stepId);
    assert.equal(result.toolCallId, id);
    assert.equal(history.filter(e => e.kind === "inputAccepted" || e.kind === "input").length, 2);
    const next = history.find(e => e.kind === "turnStart" && e.continuesTurnId === origin.turnId);
    assert.deepEqual((next?.data as { startedBy: unknown }).startedBy, { kind: "toolResult", id: result.id });
    assert.match(seen.at(-1)!, /checked color/);
    assert.doesNotMatch(seen.at(-1)!, /REPORT_MARKER|green/);
    assert.equal(handoffs.length, 1);
  });

  test(`${placement}: a denied approval never hands off`, async t => {
    let asked = 0;
    const { session, handoffs } = await fixture(t, remote, { approval: "all", onQuestion: () => { asked++; return "decline"; } });
    const turn = await session.prompt("Pick.");
    assert.equal(asked, 1);
    assert.equal(turn.toolResults()[0]?.status, "refused");
    assert.equal(handoffs.length, 0);
    assert.equal((await session.history()).some(e => e.kind === "toolStarted"), false);
  });

  test(`${placement}: expiry after the turn settles as unknown and refuses the report`, async t => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const { session, handoffs, conn } = await fixture(t, remote, { interfaceTools: [{ ...source, resultTimeoutMs: 100 }] });
    const events = session.events();
    const expired = (async () => {
      for await (const event of events) if (event.type === "toolResult" && event.data.status === "outcomeUnknown") return;
    })();
    const turn = await session.prompt("Pick.");
    assert.equal(turn.openToolCalls[0], handoffs[0].call.id);
    now = handoffs[0].deadline;
    await expired;
    assert.deepEqual(await conn.reportInterfaceToolResult(report(handoffs[0].call.id)), refused);
    await session.waitIdle();
    assert.equal((await session.lastTurn())?.text, "Continued.");
  });

  test(`${placement}: only the pinned advertisement can be released`, async t => {
    const { session, handoffs, conn, connect } = await fixture(t, remote, {}, true);
    assert.throws(() => conn.advertise([{ ...pick, description: "Not the registered definition" }]), { code: "invalid_request" });
    const turn = await session.prompt("Pick.");
    const [id] = turn.openToolCalls;
    assert.ok(id);
    assert.equal(handoffs.length, 0);
    assert.equal(await connect().release(id), false);
    assert.equal(await conn.release(id), true);
    assert.equal(await conn.release(id), false);
    assert.equal(handoffs.length, 1);
    assert.deepEqual(await conn.reportInterfaceToolResult(report(id)), completed);
    await session.waitIdle();
  });

  test(`${placement}: a report before turnEnd is not ready and expiry still settles in that turn`, async t => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    let reached!: () => void, resume!: () => void;
    const atGate = new Promise<void>(resolve => { reached = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    t.after(() => { resume(); });
    let waits = 0;
    const wait = definePlugin({ name: "hold.color", setup(r) {
      r.on("step.after", async () => {
        if (waits++ === 0) { reached(); await release; }
      });
    } });
    const { session, conn, connect, handoffs } = await fixture(t, remote, { plugins: [wait] });
    const turn = session.prompt("Pick.");
    await atGate;
    try {
      const [handed] = handoffs;
      assert.ok(handed);
      assert.deepEqual(await conn.reportInterfaceToolResult(report(handed.call.id)), { status: "refused", reason: "notReady" });
      conn.disconnect();
      const next = connect();
      now = handed.deadline;
      assert.deepEqual(await next.reportInterfaceToolResult(report(handed.call.id)), refused);
    } finally { resume(); }
    const end = await turn;
    assert.equal(end.outcome?.kind, "completed");
    assert.deepEqual(end.openToolCalls, []);
    const history = await session.history();
    const result = history.find(e => e.kind === "toolResult")!;
    assert.equal(result.turnId, end.turnId);
    assert.equal((result.data as { status: string }).status, "outcomeUnknown");
    assert.equal(history.filter(e => e.kind === "turnStart").length, 1);
  });

  test(`${placement}: a mixed continuation waits for both kinds of result and reruns only the question call`, async t => {
    let notes = 0;
    const note = tool({ name: "note", description: "Ask for a note", input: { type: "object" }, async run(_, cx) {
      notes++;
      const answer = await cx.ask({ kind: "text", question: "A note?" }, { wait: 0, then: "leaveOpen" });
      return typeof answer === "object" && "value" in answer ? answer.value : "declined";
    } });
    const { session, conn, handoffs } = await fixture(t, remote, { questionsOutlastTurns: true, tools: [note],
      providers: [scriptedProvider([{ toolCalls: [...requested.toolCalls, { name: "note", input: {} }] }, { text: "Both checked." }])] });
    const origin = await session.prompt("Pick a color and write a note.");
    assert.equal(origin.outcome?.kind, "completed");
    assert.equal(origin.openToolCalls.length, 2);
    const [question] = await session.questions();
    assert.deepEqual(await conn.reportInterfaceToolResult(report(handoffs[0].call.id)), completed);
    await session.waitIdle();
    assert.equal((await session.lastTurn())?.turnId, origin.turnId);
    await session.answer(question.id, { value: "from the answerer" });
    await session.waitIdle();
    assert.equal((await session.lastTurn())?.text, "Both checked.");
    assert.equal(handoffs.length, 1);
    assert.equal(notes, 2);
    const history = await session.history();
    const continued = history.find(e => e.continuesTurnId === origin.turnId)!;
    assert.deepEqual((continued.data as { startedBy: unknown }).startedBy, { kind: "answer", id: question.id });
    assert.equal(history.filter(e => e.kind === "toolStarted" && e.toolCallId === handoffs[0].call.id).length, 1);
  });

  for (const [cutoff, durability] of [["ended", "kept"], ["handoff", "durable"], ["handoff", "kept"]] as const) {
    test(`${placement}: SIGKILL ${cutoff}, then reopen ${durability} history`, { skip: process.platform === "win32", timeout: 15_000 }, async t => {
      const start = testResources(t);
      const dataDir = await start(() => mkdtemp(join(tmpdir(), "ma-interface-crash-")), dir => rm(dir, { recursive: true, force: true }));
      const child = fork(new URL("./fixtures/interface-tools.js", import.meta.url), ["crash", dataDir, remote ? "remote" : "in-process", cutoff, durability],
        { detached: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      child.stderr!.setEncoding("utf8").on("data", data => { stderr += data; });
      const died = once(child, "exit");
      const kill = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && !(process.platform === "darwin" && (error as NodeJS.ErrnoException).code === "EPERM")) throw error; } };
      const stop = async () => { kill(); await died; };
      await start(() => child, stop);
      const ready = await Promise.race([once(child, "message").then(([message]) => message as { id: string; callId: string }),
        died.then(() => { throw new Error(`Agent exited before handoff: ${stderr}`); })]);
      assert.ok(ready.callId);
      kill();
      assert.equal((await died)[1], "SIGKILL");
      const agent = await start(() => createAgent(options(remote, { dataDir, durability,
        ...(remote ? { processPlugins: [remoteRuntime(durability === "durable")] } : {}) })), agent => agent.close());
      const session = await agent.openSession(ready.id);
      const conn = agent.connectInterfaceTools(session.id, { actor: picker, routeId: source.routeId,
        onHandoff: () => assert.fail("Recovery replayed an executable request") });
      conn.advertise([pick]);
      if (cutoff === "handoff" && durability === "kept") {
        assert.equal((await session.lastTurn())?.outcome?.kind, "failed");
        assert.deepEqual(await conn.reportInterfaceToolResult(report(ready.callId)), refused);
        const result = (await session.history()).find(e => e.kind === "toolResult" && e.toolCallId === ready.callId);
        assert.equal((result?.data as { status: string })?.status, "outcomeUnknown");
      } else {
        assert.deepEqual((await session.lastTurn())?.openToolCalls, [ready.callId]);
        assert.deepEqual(await conn.reportInterfaceToolResult(report(ready.callId)), completed);
        await session.waitIdle();
        assert.equal((await session.lastTurn())?.text, "Continued.");
      }
      assert.equal((await session.history()).filter(e => e.kind === "toolStarted").length, 1);
    });
  }
}

test("composition rejects conflicting registrations, unsupported Runtimes and invalid timeouts", async () => {
  const unsupported = transientRuntime();
  unsupported.supports.interfaceTools = false;
  for (const extra of [{ runtime: unsupported }, { interfaceTools: [{ ...source, resultTimeoutMs: 0 }] },
    { interfaceTools: [{ ...source, resultTimeoutMs: Number.MAX_SAFE_INTEGER }] },
    { interfaceTools: [{ ...source, tools: [{ ...pick, callers: ["model", "ui"] as const }] }] },
    { tools: [tool({ name: pick.name, description: "Duplicate", input: pick.parameters, run: () => "duplicate" })] }]) {
    await assert.rejects(createAgent(options(false, extra as AgentOptions)), { code: "invalid_composition" });
  }
});

test("without Interface tools, an ordinary local tool runs and the capability is omitted", async t => {
  const a = await createAgent(options(false, { interfaceTools: undefined, tools: [tool({ name: pick.name, description: pick.description,
    input: pick.parameters, run: () => "local result" })] }));
  t.after(() => a.close());
  assert.equal(Object.hasOwn(a.declaration(), "interfaceTools"), false);
  assert.equal((await (await a.session()).prompt("Pick.")).toolResults()[0].text(), "local result");
});

test("changed executor output does not become a handoff and modelTools limits the offer", async t => {
  const gate = definePlugin({ name: "hide.palette", setup(r) {
    r.on("output", ({ recipient, events }) => recipient === picker.id && events.some(e => e.type === "tool.handoff") ? "block" : undefined);
  } });
  for (const extra of [{ plugins: [gate] }, { settings: { modelTools: [] } }]) {
    const { session, handoffs } = await fixture(t, false, extra);
    const turn = await session.prompt("Pick.");
    assert.equal(turn.toolResults()[0]?.status, "refused");
    assert.equal(handoffs.length, 0);
    assert.equal((await session.history()).some(e => e.kind === "toolStarted"), false);
  }
});

test("the report is schema checked and a processing failure still settles once", async t => {
  const { session, conn, handoffs } = await fixture(t, false);
  await session.prompt("Pick.");
  const id = handoffs[0].call.id;
  await assert.rejects(conn.reportInterfaceToolResult(report(id, 12)), /Invalid tool output/);
  assert.deepEqual(await conn.reportInterfaceToolResult(report(id)), { status: "alreadySettled" });
  await session.waitIdle();
  const results = (await session.history()).filter(e => e.kind === "toolResult");
  assert.equal(results.length, 1);
  assert.equal((results[0].data as { status: string }).status, "failed");
  assert.doesNotMatch(JSON.stringify(results), /REPORT_MARKER/);
});

for (const pending of [false, true]) test(`${pending ? "reconciliation" : "erasure"} invalidates a pending handoff`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "interface-erasure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { session, conn } = await fixture(t, false, { durability: "kept", project: dir, dataDir: dir }, pending);
  await session.prompt("Pick.");
  const start = (await session.history()).find(e => e.kind === "toolStarted")!;
  const id = start.toolCallId!;
  if (pending) {
    const registry = new JsonlHistoryStore(join(dir, "history")).pendingErasure;
    await registry.exclusive(async () => registry.keep({ id: "handoff-erasure", sessionId: session.id, targets: [start.id],
      actorId: "user", copies: [{ sessionId: session.id, id: start.id, erased: false }] }));
    await session.history();
    assert.equal(await conn.release(id), false);
  } else assert.ok((await session.erase([start.id])).outOfReach.length);
  assert.deepEqual(await conn.reportInterfaceToolResult(report(id)), refused);
  await session.waitIdle();
  const history = await session.history();
  assert.equal(history.filter(e => e.kind === "turnStart").length, 1);
  assert.ok(history.some(e => e.kind === "toolResult" && e.toolCallId === id));
  assert.doesNotMatch(JSON.stringify(history.find(e => e.id === start.id)), /ARGUMENT_MARKER/);
});

test("an open Interface call blocks branch changes and close without cancel", async t => {
  const { session, conn, handoffs } = await fixture(t, false);
  const end = await session.prompt("Pick.");
  const history = await session.history();
  await assert.rejects(session.moveTo(history[0].id), { code: "busy" });
  await assert.rejects(session.fork(), { code: "busy" });
  await assert.rejects(session.as(picker.id).close(), { code: "forbidden" });
  await session.cancel();
  await session.waitIdle();
  assert.deepEqual(await conn.reportInterfaceToolResult(report(handoffs[0].call.id)), refused);
  const result = (await session.history()).find(e => e.kind === "toolResult")!;
  assert.equal(result.turnId, end.turnId);
  assert.equal(result.actorId, undefined);
  assert.equal((result.data as { status: string }).status, "outcomeUnknown");
});

test("erasing a checked result erases its continuation copies", async t => {
  const { session, conn, handoffs } = await fixture(t, false);
  await session.prompt("Pick.");
  await conn.reportInterfaceToolResult(report(handoffs[0].call.id));
  await session.waitIdle();
  const before = await session.history();
  const result = before.find(e => e.kind === "toolResult")!;
  assert.match(JSON.stringify(result), /REPORT_MARKER/);
  const erased = await session.erase([result.id]);
  assert.ok(erased.outOfReach.length);
  assert.deepEqual(await conn.reportInterfaceToolResult(report(handoffs[0].call.id)), refused);
  assert.doesNotMatch(JSON.stringify(await session.history()), /REPORT_MARKER/);
});

test("handoff ends a pending span; authorized settlement and continuation have separate spans", async t => {
  const exporter = new InMemorySpanExporter();
  const tracer = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(tracer);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  t.after(async () => { await tracer.shutdown(); trace.disable(); context.disable(); });
  const { session, conn, handoffs } = await fixture(t, false);
  const origin = await session.prompt("Pick.");
  await conn.reportInterfaceToolResult(report(handoffs[0].call.id));
  await session.waitIdle();
  const spans = exporter.getFinishedSpans();
  const dispatch = spans.find(s => s.name === "execute_tool pick_color")!;
  const settle = spans.find(s => s.name === "modular_agent.tool.settle")!;
  assert.equal(dispatch.attributes["modular_agent.tool.status"], "pending");
  assert.equal(settle.attributes["modular_agent.tool.status"], "completed");
  assert.equal(settle.links[0]?.context.spanId, dispatch.spanContext().spanId);
  assert.equal(settle.parentSpanContext?.spanId, spans.find(s => s.name === "modular_agent.interface.report")?.spanContext().spanId);
  const turnSpans = spans.filter(s => s.name === "invoke_agent");
  assert.equal(turnSpans.length, 2);
  assert.equal(turnSpans[1].links[0]?.context.spanId, turnSpans.find(s => s.attributes["modular_agent.turn.id"] === origin.turnId)?.spanContext().spanId);
  assert.doesNotMatch(JSON.stringify([dispatch.attributes, settle.attributes]), /ARGUMENT_MARKER|REPORT_MARKER|palette/);
});
