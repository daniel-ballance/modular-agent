import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, tool, type Question } from "../src/index.js";
import { restart, testAgent } from "../src/testing.js";

const input = { type: "object" } as const;
const script = [{ toolCalls: [{ name: "parent", input: {} }] }, { text: "Done" }];

test("one displayed parent allow covers children and grandchildren of that dispatch", async t => {
  const questions: Question[] = [];
  let effects = 0;
  const agent = await testAgent({ approval: "all", approvalCoversNested: true, script,
    onQuestion(q) { questions.push(q); return q.call?.name === "parent" ? "allow" : "decline"; },
    tools: [
      tool({ name: "parent", description: "Parent", input, run: (_, c) => c.tools.call("middle", {}) }),
      tool({ name: "middle", description: "Middle", input, run: (_, c) => c.tools.call("child", {}) }),
      tool({ name: "child", description: "Child", input, run: () => String(++effects) }),
    ] });
  t.after(() => agent.close());
  assert.equal(agent.declaration().approvalCoversNested, true);
  const session = await agent.session();
  assert.equal((await session.prompt("Run")).toolResults()[0].status, "completed");
  assert.equal(effects, 1);
  assert.deepEqual(questions.map(q => [q.call?.name, q.coversNested]), [["parent", true]]);
  const starts = (await session.history()).filter(e => e.kind === "toolStarted");
  const by = { toolCallId: starts[0].toolCallId, requestId: questions[0].id };
  assert.deepEqual(starts.map(e => (e.data as { approvalCoveredBy?: unknown }).approvalCoveredBy), [undefined, by, by]);
});

for (const reason of ["parent declined", "never", "read-only parent", "child gate", "coverage off"] as const) {
  test(reason + ": no child runs on an implicit or refused allow", async t => {
    const questions: Question[] = [], ran: string[] = [];
    const agent = await testAgent({ script, approval: reason === "never" ? "never" : reason === "read-only parent" ? "ask" : "all",
      approvalCoversNested: reason !== "coverage off",
      onQuestion(q) { questions.push(q); return q.call?.name === "parent" && reason !== "parent declined" ? "allow" : "decline"; },
      tools: [tool({ name: "child", description: "Child", input, run() { ran.push("child"); } }),
        tool({ name: "parent", description: "Parent", readOnly: reason === "read-only parent", input, run(_, c) { ran.push("parent"); return c.tools.call("child", {}); } })],
      plugins: [definePlugin({ name: "guard", hooks: { "tool.before": ({ call }) => reason === "child gate" && call.name === "child" ? { refuse: "Stopped by guard" } : undefined } })],
    });
    t.after(() => agent.close());
    const session = await agent.session();
    assert.equal((await session.prompt("Run")).toolResults()[0].status, "refused");
    assert.deepEqual(ran, reason === "never" || reason === "parent declined" ? [] : ["parent"]);
    const expected = { "never": [], "parent declined": ["parent"], "read-only parent": ["child"], "child gate": ["parent"], "coverage off": ["parent", "child"] };
    assert.deepEqual(questions.map(q => q.call?.name), expected[reason]);
    assert.deepEqual(questions.map(q => q.coversNested), expected[reason].map(n => n === "parent" && reason !== "coverage off" ? true : undefined));
  });
}

test("never still refuses a child after the parent received an allow", async t => {
  const questions: string[] = [];
  let forbid!: () => Promise<void>, effects = 0;
  const agent = await testAgent({ approval: "all", approvalCoversNested: true, script: [{ text: "Ready" }],
    onQuestion(q) { questions.push(q.call!.name); return "allow"; },
    tools: [tool({ name: "parent", description: "Parent", input, async run(_, c) {
      await forbid(); return c.tools.call("child", {});
    } }), tool({ name: "child", description: "Child", input, run: () => String(++effects) })] });
  t.after(() => agent.close());
  const session = await agent.session();
  await session.prompt("Ready");
  forbid = () => session.setSetting("approval", "never");
  assert.equal((await session.callTool("parent", {})).status, "refused");
  assert.deepEqual(questions, ["parent"]);
  assert.equal(effects, 0);
});

test("a live SDK route cannot allow a request after a gate removes coversNested", async t => {
  let effects = 0, delivered = 0;
  const agent = await testAgent({ script, approval: "all", approvalCoversNested: true,
    tools: [tool({ name: "parent", description: "Parent", input, run: () => String(++effects) })],
    onQuestion() { delivered++; return "allow"; },
    plugins: [definePlugin({ name: "redact-coverage", hooks: { output({ events }) {
      if (events.some(e => (e.data as Question)?.coversNested)) {
        return { redact: events.map(e => ({ ...e, data: { ...(e.data as Question), coversNested: undefined } })) };
      }
    } } })] });
  t.after(() => agent.close());
  const session = await agent.session();
  assert.equal((await session.prompt("Run")).toolResults()[0].status, "refused");
  assert.equal(delivered, 0); assert.equal(effects, 0);
});

test("the option without an approval plugin declares no coverage", async t => {
  const agent = await testAgent({ script: [], approvalCoversNested: true });
  t.after(() => agent.close());
  assert.equal(agent.declaration().approvalCoversNested, undefined);
});

for (const marked of [true, false]) test("continuation uses only the original view: coversNested " + marked, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "covered-wait-"));
  let effects = 0;
  const options = { script, dataDir, durability: "kept" as const, questionsOutlastTurns: true, maxApprovalWaitMs: 60_000, approval: "all" as const,
    tools: [tool({ name: "parent", description: "Parent", input, run: (_, c) => c.tools.call("child", {}) }),
      tool({ name: "child", description: "Child", input, run: () => String(++effects) })] };
  let agent = await testAgent({ ...options, approvalCoversNested: marked });
  try {
    const origin = await agent.session({ settings: { approvalWait: "untilDeadline" } });
    const turn = await origin.prompt("Run"), [id] = turn.openToolCalls;
    assert.ok(id);
    await agent.close();
    agent = await testAgent({ ...options, approvalCoversNested: true });
    const session = await agent.openSession(origin.id);
    const [q] = await session.questions({ present: true });
    assert.equal(q.coversNested, marked || undefined);
    await session.answer(q.id, "allow");
    await session.waitIdle();
    const history = await session.history();
    const starts = history.filter(e => e.kind === "toolStarted");
    assert.equal(starts.length, marked ? 2 : 1);
    assert.equal(effects, Number(marked));
    assert.equal(starts[0].turnId, history.find(e => e.continuesTurnId === turn.turnId && e.kind === "turnStart")?.turnId);
    assert.equal(history.filter(e => e.kind === "inputRequest").length, marked ? 1 : 2);
    if (marked) assert.deepEqual((starts[1].data as {approvalCoveredBy?: unknown}).approvalCoveredBy, { toolCallId: id, requestId: q.id });
  } finally { await agent.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("a recovered parent needs a new live allow", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "covered-recovery-"));
  function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
  const entered = latch(), release = latch();
  const ids: string[] = [];
  let effects = 0;
  let agent = await testAgent({ dataDir, durability: "durable", script, approval: "all", approvalCoversNested: true,
    onQuestion(q) { ids.push(q.id); return ids.length === 1 ? "allow" : "decline"; },
    tools: [tool({ name: "parent", description: "Parent", input, run: () => String(++effects) })],
    plugins: [definePlugin({ name: "after-approval", hooks: { "tool.before": async () => { entered.resolve(); await release.promise; } } })] });
  try {
    const origin = await agent.session();
    await origin.send("Run", "now");
    await entered.promise;
    agent = await restart(agent);
    release.resolve();
    const session = await agent.openSession(origin.id);
    await session.waitIdle();
    assert.equal(new Set(ids).size, 2);
    assert.equal((await session.lastTurn())?.toolResults()[0].status, "refused");
    assert.equal(effects, 0);
  } finally { release.resolve(); await agent.close(); await rm(dataDir, { recursive: true, force: true }); }
});
