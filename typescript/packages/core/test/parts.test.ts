import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { definePlugin, durableRuntime, localEnvironment, tool, transientRuntime } from "../src/index.js";
import { overWire, restart, testAgent } from "../src/testing.js";

const input = { type: "object" } as const;

test("in-process restart keeps the record and settles a child before its interrupted parent", async t => {
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  let invocations = 0, stops = 0;
  const parent = tool({ name: "parent", description: "Parent", input, run: (_, cx) => cx.tools.call("child", {}) });
  const child = tool({ name: "child", description: "Child", input, async run(_, cx) {
    invocations++;
    started();
    await delay(30_000, undefined, { signal: cx.cancelled });
  } });
  const plugin = definePlugin({ name: "parts", tools: [parent, child], stop() { stops++; } });
  const agent = await testAgent({ plugins: [plugin], script: [{ toolCalls: [{ name: "parent", input: {} }] }] });
  t.after(() => agent.close());
  const session = await agent.session();
  const pending = session.prompt("Interrupted").catch(e => e);
  await ready;
  const again = await restart(agent);
  t.after(() => again.close());
  assert.equal(stops, 0);
  await pending;
  const recovered = await again.openSession(session.id);
  assert.equal(invocations, 1);
  assert.equal((await recovered.lastTurn())?.outcome?.kind, "failed");
  const results = (await recovered.history()).filter(e => e.kind === "toolResult");
  assert.deepEqual(results.map(e => [e.message?.role === "toolResult" && e.message.toolName,
    (e.data as { status?: string })?.status, e.modelVisible]), [["child", "outcomeUnknown", false], ["parent", "outcomeUnknown", true]]);
});

test("session events replay past the cursor, then switch to live delivery", async t => {
  const agent = await testAgent({ script: [{ text: "First" }, { text: "Second" }] });
  t.after(() => agent.close());
  const session = await agent.session();
  await session.prompt("First");
  const existing = await session.history();
  const cursor = existing.at(-2)!;
  const reader = session.events(cursor.id)[Symbol.asyncIterator]();
  const first = (await reader.next()).value;
  assert.equal(first?.type, "entry");
  assert.equal(first.data.id, existing.at(-1)?.id);
  await session.prompt("Second");
  const ids: string[] = [];
  try {
    for (;;) {
      const { value } = await reader.next();
      if (value.type === "entry") ids.push(value.data.id);
      if (value.type === "turnEnded") break;
    }
  } finally { await reader.return?.(); }
  assert.deepEqual(ids, (await session.history()).slice(existing.length).map(e => e.id));
  await assert.rejects(session.events("not-a-cursor")[Symbol.asyncIterator]().next(), { code: "not_found" });
});

test("a lagging event reader disconnects with its last visible entry, which can resume", async t => {
  const agent = await testAgent({ script: [{ text: "unused" }] });
  t.after(() => agent.close());
  const session = await agent.session();
  await session.setSetting("fixture", -1);
  const reader = session.events()[Symbol.asyncIterator]();
  const first = (await reader.next()).value;
  assert.equal(first.type, "entry");
  for (let i = 0; i < 1100; i++) await session.setSetting("fixture", i);
  await assert.rejects(reader.next(), { code: "lost", data: { fromEntry: first.data.id } });
  const fresh = session.events(first.data.id)[Symbol.asyncIterator]();
  assert.equal((await fresh.next()).value.data.id, (await session.history())[1].id);
  await fresh.return?.();
});

test("SDK part constructors and registration replace defaults; non-servable parts fail setup", async t => {
  assert.equal(durableRuntime().supports.continuesAfterRestart, true);
  await assert.rejects(testAgent({ script: [], runtime: durableRuntime() }), { code: "invalid_composition" });
  const env = localEnvironment();
  const fixture = tool({ name: "list", description: "Read the working directory", input,
    async run(_, cx) { return (await cx.environment.list(".")).find(e => e.name === "package.json")?.kind ?? "missing"; } });
  const plugin = definePlugin({ name: "parts", replaces: ["working-environment", "runtime"], setup(r) {
    r.environment(env);
    r.runtime(transientRuntime());
    r.tools({ id: "list-tools", tools: () => [fixture] });
  } });
  const agent = await testAgent({ plugins: [overWire(plugin)], script: [{ toolCalls: [{ name: "list", input: {} }] }, { text: "Done" }] });
  t.after(() => agent.close());
  const result = await (await agent.session()).prompt("List");
  assert.equal(result.toolResults()[0].text(), "file");
  await assert.rejects(testAgent({ script: [], plugins: [overWire(definePlugin({ name: "not-servable", setup(r) {
    r.interface({ start() {} });
  } }))] }), { code: "invalid_composition" });
});
