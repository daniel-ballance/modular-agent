import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, definePlugin, fileHistory, memoryHistory, ModelFailure, tool, transientRuntime } from "../src/index.js";
import { answers, memoryEnvironment, overWire, scriptedProvider, testAgent } from "../src/testing.js";

const input = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } as const;
const script = [{ toolCalls: [{ name: "measure", input: { amount: 2 } }] }, { text: "done" }];

test("composition checks the effective history, environment and plugin-host choices", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ma-parts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = fileHistory(join(dir, "history"));
  await assert.rejects(createAgent({ pluginHost: false, processPlugins: [] }), { code: "invalid_composition" });
  await assert.rejects(createAgent({ durability: "kept", history }), { code: "invalid_composition", message: /bookkeeping/ });
  await assert.rejects(testAgent({ script: [], durability: "kept", dataDir: dir, history: memoryHistory() }), { code: "invalid_composition" });
  const kept = await createAgent({ durability: "kept", history, environment: memoryEnvironment() });
  t.after(() => kept.close());
  assert.equal(kept.declaration().portableSessions, true);
  assert.equal(kept.declaration().commandContainment, "none");
  assert.equal(kept.declaration().confinesFiles, true);
  assert.equal(kept.declaration().erasure, true);
  const local = await createAgent();
  t.after(() => local.close());
  assert.equal(local.declaration().confinesFiles, false);
  assert.equal(local.declaration().commandContainment, process.platform === "linux" ? "strong" : "processGroup");
});

test("declaration reflects the replacement Runtime and memory supports erasure", async t => {
  const runtime = transientRuntime();
  Object.assign(runtime.supports, { nestedToolCalls: false, queuedJobReportsAfterRestart: "handedBack" });
  const a = await testAgent({ script: [{ text: "hello" }], runtime });
  t.after(() => a.close());
  assert.equal(a.declaration().nestedToolCalls, false);
  assert.equal(a.declaration().settingsDuringTurn, "nextTurn");
  assert.equal(a.declaration().queuedInputAfterRestart, "handedBack");
  assert.equal(Object.hasOwn(a.declaration(), "queuedJobReportsAfterRestart"), false);
  const s = await a.session();
  await s.prompt("Erase this");
  const { id } = (await s.history()).find(e => e.kind === "input")!;
  assert.ok((await s.erase([id])).erased.includes(id));
});

test("answers reports both unexpected questions and unused answers", async t => {
  const queue = answers([{ value: "declined" }]);
  assert.throws(() => queue.assertDone(), /Unused answers: 1/);
  const measured = tool({ name: "measure", description: "Ask twice", input, async run(_, cx) {
    const one = await cx.ask({ kind: "text", question: "First?" });
    const two = await cx.ask({ kind: "text", question: "Second?" });
    assert.deepEqual(one, { value: "declined" });
    assert.ok(typeof two === "object" && "declined" in two);
    return "asked";
  } });
  const a = await testAgent({ script, tools: [measured], onQuestion: queue });
  t.after(() => a.close());
  assert.equal((await (await a.session()).prompt("Ask")).toolResults()[0].text(), "asked");
  assert.throws(() => queue.assertDone(), /Unused answers: 0; unexpected questions: Second\?/);
});

test("an unknown model is rejected without an input admission", async t => {
  await assert.rejects(testAgent({ script, model: "scripted/unknown" }), { code: "invalid_request" });
  const a = await testAgent({ script });
  t.after(() => a.close());
  const s = await a.session({ settings: { model: "scripted/unknown" } });
  await assert.rejects(s.prompt("Do not admit"), { code: "invalid_request" });
  assert.equal((await s.history()).some(e => e.kind === "inputAccepted"), false);
});

for (const placement of ["local", "wire"] as const) {
  const place = (plugin: ReturnType<typeof definePlugin>) => placement === "wire" ? overWire(plugin) : plugin;

  test(`${placement}: admitted Provider exceptions are recorded ModelErrors`, async t => {
    const p = scriptedProvider([]);
    p.request = (_model, request) => {
      if (request.messages.some(m => m.content.some(part => part.type === "text" && part.text === "typed"))) {
        throw new ModelFailure({ kind: "temporary", message: "typed problem" });
      }
      throw new Error("ordinary problem");
    };
    const a = await createAgent({ environment: memoryEnvironment(), plugins: [place(definePlugin({ name: "failing-model", setup(r) { r.provider(p); } }))] });
    t.after(() => a.close());
    for (const [prompt, kind] of [["ordinary", "other"], ["typed", "temporary"]]) {
      const s = await a.session();
      assert.equal((await s.prompt(prompt)).outcome?.kind, "failed");
      const response = (await s.history()).find(e => e.kind === "response")?.message;
      assert.equal(response?.role, "assistant");
      assert.equal(response.stop, "failed");
      assert.deepEqual(response.error, { kind, message: `${prompt} problem` });
    }
  });

  test(`${placement}: tool.after changes content and value; step.after ends the turn failed`, async t => {
    const measured = tool({ name: "measure", description: "Measure", input, output: { type: "number" }, run: ({ amount }) => amount });
    const plugin = place(definePlugin({ name: "hooks", tools: [measured], hooks: {
      "tool.after": ({ result }) => ({ change: { value: Number(result.value) + 1, content: [{ type: "text", text: "changed" }] } }),
      "step.after": () => ({ end: "step denied" }),
    } }));
    const a = await testAgent({ script, plugins: [plugin] });
    t.after(() => a.close());
    const turn = await (await a.session()).prompt("Measure");
    assert.deepEqual(turn.outcome, { kind: "failed", error: "step denied" });
    assert.deepEqual(turn.toolResults().map(r => [r.status, r.value, r.text()]), [["completed", 3, "changed"]]);
  });

  test(`${placement}: an invalid transformed tool value fails the turn without redispatch`, async t => {
    let calls = 0;
    const measured = tool({ name: "measure", description: "Measure", input, output: { type: "number" }, run: () => ++calls });
    const plugin = place(definePlugin({ name: "bad-result", tools: [measured], hooks: {
      "tool.after": () => ({ change: { value: "not a number" } }),
    } }));
    const a = await testAgent({ script, plugins: [plugin] });
    t.after(() => a.close());
    const turn = await (await a.session()).prompt("Measure");
    assert.match(turn.outcome?.kind === "failed" ? turn.outcome.error : "", /Invalid tool output/);
    assert.deepEqual(turn.toolResults().map(r => [r.status, r.value]), [["completed", undefined]]);
    assert.equal(calls, 1);
  });
}

test("script indexing uses assistant messages in the final request", async t => {
  const a = await testAgent({ script: [{ text: "first" }, { text: "second" }], plugins: [definePlugin({ name: "drop-context", hooks: {
    "provider.request": ({ request }) => ({ change: { ...request, messages: request.messages.filter(m => m.role !== "assistant") } }),
  } })] });
  t.after(() => a.close());
  const s = await a.session();
  assert.equal((await s.prompt("first time")).text, "first");
  assert.equal((await s.prompt("second time")).text, "first");
});

test("prompt stream lag includes the last delivered kept entry (or null)", async t => {
  const p = scriptedProvider([]);
  let finish!: () => void;
  const finished = new Promise<void>(r => { finish = r; });
  p.request = async (_m, _r, cx) => {
    await finished;
    for (let i = 0; i < 1100; i++) cx.piece("text", "x");
    return { role: "assistant", stop: "finished", content: [{ type: "text", text: "done" }] };
  };
  const a = await createAgent({ providers: [p], environment: memoryEnvironment() });
  t.after(() => a.close());
  const s = await a.session();
  const reader = s.promptStream("Stream")[Symbol.asyncIterator]();
  const first = await reader.next();
  assert.equal(first.done, false);
  const cursor = first.value.type === "entry" ? first.value.data.id : null;
  finish();
  await s.prompt("Drain the first turn");
  await assert.rejects(reader.next(), { code: "lost", data: { fromEntry: cursor } });
  const resumed = s.events(cursor)[Symbol.asyncIterator]();
  const entries = await s.history();
  assert.equal((await resumed.next()).value.data.id, entries[entries.findIndex(e => e.id === cursor) + 1].id);
  await resumed.return?.();
});

