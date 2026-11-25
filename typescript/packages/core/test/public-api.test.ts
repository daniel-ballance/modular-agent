import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent, definePlugin, defineToolSource, environmentCredentials, tool, transientRuntime,
  type CommandContext, type Content, type CustomHook, type WriterHistoryStore } from "@modular-agent/core";
import { answers, memoryEnvironment, overWire, scriptedProvider, testAgent } from "@modular-agent/core/testing";

const empty = { type: "object" } as const;

for (const served of [false, true]) {
  test(`the ${served ? "served" : "local"} SDK Provider port declares state but not Provider-run tools or live sessions`, async t => {
    const provider = { ...scriptedProvider([]), supports: {
      keepsState: true, safeToRepeat: false, runsTools: true, liveSessions: true,
    } };
    const plugin = definePlugin({ name: "provider-declaration", setup: r => r.provider(provider) });
    const agent = await createAgent({ plugins: [served ? overWire(plugin) : plugin], environment: memoryEnvironment() });
    t.after(() => agent.close());
    const { keepsStateAtProvider, runsToolsAtProvider, liveSessions } = agent.declaration();
    assert.deepEqual({ keepsStateAtProvider, runsToolsAtProvider, liveSessions }, {
      keepsStateAtProvider: true, runsToolsAtProvider: false, liveSessions: false,
    });
  });
}

test("a custom Runtime, history, configuration, credential store and Interface work through registration", async t => {
  const kept = new Map<string, Awaited<ReturnType<WriterHistoryStore["load"]>>>();
  const store: WriterHistoryStore = {
    supports: { erasure: false },
    async create(meta) { kept.set(meta.id, { meta, entries: [] }); },
    async openForWriting() {}, async close() {},
    async append(id, entries) { kept.get(id)!.entries.push(...structuredClone(entries)); },
    async load(id) { return structuredClone(kept.get(id)!); },
    async list() { return [...kept.values()].map(({ meta }) => meta); },
  };
  const provider = scriptedProvider([]);
  provider.request = async (_model, req, cx) => {
    assert.equal(await cx.credential(), "example-only");
    return { role: "assistant", stop: "finished", content: req.messages.at(-1)!.content };
  };
  const runtime = transientRuntime();
  let turns = 0, stopped = false;
  const baseTurn = runtime.runTurn.bind(runtime);
  runtime.runTurn = (...args) => { turns++; return baseTurn(...args); };
  const replaces = ["runtime", "history", "configuration", "credentials"];
  const plugin = definePlugin({ name: "adapters", replaces, setup(r) {
    r.runtime(runtime);
    r.historyStore(store);
    r.configuration({
      trusted: project => project === process.cwd(),
      async settings() { return { title: "From configuration", model: provider.models()[0] }; },
    });
    r.credentialStore({ ...environmentCredentials(), read: async () => "example-only" });
    r.interface({ async start(agent) { assert.equal(agent.models()[0].provider, provider.id); }, stop() { stopped = true; } });
  } });
  const options = { model: provider.models()[0], providers: [provider], environment: memoryEnvironment(),
    credentials: { ...environmentCredentials(), read: async () => "option-only" } };
  for (const item of ["history", "configuration", "credentials"]) {
    await assert.rejects(createAgent({ ...options, plugins: [{ ...plugin, replaces: replaces.filter(r => r !== item) }] }),
      { code: "invalid_composition", message: `${item} is already registered` });
  }
  for (const old of ["history-store", "credential-store"]) {
    await assert.rejects(createAgent({ ...options, plugins: [{ ...plugin, replaces: [...replaces, old] }] }),
      { code: "invalid_composition" });
  }
  const agent = await createAgent({ ...options, plugins: [plugin] });
  t.after(() => agent.close());
  const s = await agent.session();
  assert.equal(s.settings().title, "From configuration");
  assert.equal((await s.prompt("Hello")).text, "Hello");
  assert.equal(turns, 1);
  assert.ok(kept.get(s.id)?.entries.some(e => e.kind === "turnEnd"));
  await agent.close();
  assert.equal(stopped, true);
});

for (const placement of ["local", "wire"]) {
  test(`${placement}: a changing tool source and the command environment follow the session`, async t => {
    const make = (name: string) => tool({ name, description: name, input: empty, run: () => name });
    let current = [make("first")];
    const source = defineToolSource({ id: "changing", tools: () => current });
    const plugin = definePlugin({ name: "changing", setup(r) {
      r.tools(source);
      r.command("read", "Read from the environment", async (path, cx) => (await cx.environment.read(path)).toString());
      r.command("refresh", "Refresh the tool catalog", () => { current = [make("second")]; source.changed(); });
    } });
    const agent = await testAgent({ script: [], environment: memoryEnvironment({ "value.txt": "scoped" }),
      plugins: [placement === "wire" ? overWire(plugin) : plugin] });
    t.after(() => agent.close());
    const s = await agent.session();
    assert.equal(await s.runCommand("/read value.txt"), "scoped");
    assert.equal((await s.callTool("first", {})).text(), "first");
    // A notification made during the command must be applied before its reply settles.
    await s.runCommand("/refresh");
    await assert.rejects(s.callTool("first", {}), { code: "not_found" });
    assert.equal((await s.callTool("second", {})).text(), "second");
  });
}

test("an in-process command asks a question; a custom hook collects from another plugin in order", async t => {
  let summary!: CustomHook<string, string, string[]>;
  let saved!: CommandContext;
  const owner = definePlugin({ name: "owner", setup(r) {
    summary = r.defineHook("summary.collect", "collect");
    summary.on(text => text.toUpperCase(), "last");
    r.command("combine", "Combine a response", async (_, cx) => {
      saved = cx;
      const reply = await cx.ask({ kind: "text", question: "A greeting?" });
      assert.ok(typeof reply === "object" && "value" in reply);
      return (await summary.call(reply.value)).join("/");
    }, { inProcessOnly: true });
  } });
  const subscriber = definePlugin({ name: "subscriber", setup(r) { r.onHook(summary, text => `said ${text}`); } });
  const onQuestion = answers([{ value: "hello" }]);
  const agent = await testAgent({ script: [], plugins: [owner, subscriber], onQuestion });
  t.after(() => agent.close());
  const s = await agent.session();
  assert.equal(await s.runCommand("/combine"), "said hello/HELLO");
  onQuestion.assertDone();
  assert.equal(await s.lastTurn(), undefined);
  await assert.rejects(saved.ask({ kind: "text", question: "Too late" }), { code: "invalid_request" });
});

test("proposals, generic Content, typed tool events and history movement use the public session", async t => {
  const lifecycle: string[] = [];
  const agent = await testAgent({ script: [{ toolCalls: [{ name: "tide", input: {} }] }, { text: "High tide" }], severalActors: true,
    plugins: [definePlugin({ name: "observe-actors", hooks: {
      "session.join": ({ actor }) => { lifecycle.push(`join ${actor.id}`); },
      "session.leave": ({ actorId }) => { lifecycle.push(`leave ${actorId}`); },
    } })],
    tools: [tool({ name: "tide", description: "Tide", input: empty, run: () => "high" })],
  });
  t.after(() => agent.close());
  const s = await agent.session({ actors: [{ id: "reader", kind: "program", rights: ["watch", "propose", "tools"] }] });
  const visitor = s.as("reader");
  const content: Content = [{ type: "text", text: "Find the tide" }, { type: "application.example", label: "keep this" }];
  const drop = await visitor.send("Withdraw this", "propose");
  await visitor.withdraw(drop.inputId);
  await assert.rejects(visitor.withdraw(drop.inputId), { code: "conflict" });
  const decline = await visitor.send("Decline this", "propose");
  assert.deepEqual(await s.release(decline.inputId, "after", { declined: true }), { inputId: decline.inputId, taken: "handedBack" });
  await assert.rejects(s.release(decline.inputId, "now"), { code: "conflict" });
  await assert.rejects(visitor.withdraw(decline.inputId), { code: "conflict" });
  assert.equal(await s.lastTurn(), undefined);
  const next = await visitor.send(content, "propose");
  assert.deepEqual((await s.proposals()).map(p => [p.inputId, p.content]), [[next.inputId, content]]);
  await assert.rejects(visitor.release(next.inputId), { code: "forbidden" });
  const cursor = (await s.history()).at(-1)!.id;
  const read = s.events(cursor)[Symbol.asyncIterator]();
  assert.deepEqual(await s.release(next.inputId, "now"), { inputId: next.inputId, taken: "now" });
  await assert.rejects(visitor.withdraw(next.inputId), { code: "conflict" });
  assert.deepEqual(await s.proposals(), []);
  const observed: string[] = [];
  try {
    for (;;) {
      const { value: e } = await read.next();
      if (e.type === "toolCall") observed.push(e.data.call.name);
      if (e.type === "toolResult") observed.push(e.data.status);
      if (e.type === "turnEnded") break;
    }
  } finally { await read.return?.(); }
  assert.deepEqual(observed, ["tide", "completed"]);
  const input = (await s.history()).find(e => e.kind === "input")!;
  assert.deepEqual(input.message?.content, content);
  await s.moveTo(cursor);
  assert.equal((await s.history({ all: false })).at(-1)?.id, cursor);
  assert.ok((await s.erase([input.id])).erased.some(copy => copy.sessionId === s.id && copy.id === input.id));
  await s.leave("reader");
  assert.deepEqual(lifecycle, ["join reader", "leave reader"]);
});
