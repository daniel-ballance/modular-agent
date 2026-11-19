import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { definePlugin, tool, type ToolContext } from "../src/index.js";
import { overWire, testAgent } from "../src/testing.js";

const empty = { type: "object", additionalProperties: false } as const;
const question = { toolCalls: [{ name: "parent", input: {} }] };

for (const placement of ["local", "wire"] as const) {
  test(`a ${placement} SDK tool lists and calls a gated plugin-only child`, async t => {
    const approved: string[] = [];
    let saved!: ToolContext;
    let listed: string[] = [];
    const child = tool({ name: "child", description: "Child", callers: ["plugin"], input: empty, run: () => "child value" });
    const parent = tool({ name: "parent", description: "Parent", input: empty, async run(_input, cx) {
      saved = cx;
      listed = (await cx.tools.list()).map(tool => tool.name);
      const ran = await cx.tools.call("child", {});
      assert.equal(ran.status, "completed");
      const missing = await cx.tools.call("missing", {});
      assert.equal(missing.status, "refused");
      return { content: ran.content, status: ran.status };
    } });
    const plugin = definePlugin({ name: "caller", tools: [parent] });
    const agent = await testAgent({ tools: [child], plugins: [placement === "wire" ? overWire(plugin) : plugin],
      script: [question, { text: "Done" }], settings: { modelTools: ["parent"] }, approval: "all",
      onQuestion(q) { approved.push(q.call!.name); return "allow"; },
    });
    t.after(() => agent.close());
    const session = await agent.session();
    const turn = await session.prompt("Try it");
    assert.equal(turn.text, "Done");
    assert.deepEqual(approved, ["parent", "child"]);
    assert.deepEqual(listed.sort(), ["child", "parent"]);
    assert.equal(turn.toolResults().find(r => r.name === "parent")?.text(), "child value");
    const history = await session.history();
    const starts = history.filter(e => e.kind === "toolStarted");
    assert.equal(starts.length, 2);
    const [p, c] = starts;
    assert.deepEqual((c.data as { call?: unknown })?.call, { id: c.toolCallId, name: "child", input: {}, startedBy: "tool", parentCallId: p.toolCallId, stepId: p.stepId, actorId: "user" });
    assert.equal(c.turnId, p.turnId);
    assert.equal(c.modelVisible, false);
    const results = history.filter(e => e.kind === "toolResult");
    assert.deepEqual(results.map(e => [e.message?.role === "toolResult" && e.message.toolName, e.modelVisible]), [["child", false], ["missing", false], ["parent", true]]);
    assert.deepEqual(history.filter(e => e.kind === "modelRequest").map(e => (e.data as { tools?: unknown })?.tools), [["parent"], ["parent"]]);
    await assert.rejects(saved.tools.list(), { code: "invalid_request" });
  });
}

test("nested calls stop at the depth limit and settle from the bottom up", async t => {
  const parent = tool({ name: "parent", description: "Recursive", input: empty,
    async run(_input, cx) { return cx.tools.call("parent", {}); } });
  const agent = await testAgent({ tools: [parent], script: [question, { text: "Done" }] });
  t.after(() => agent.close());
  const session = await agent.session();
  const turn = await session.prompt("Try it");
  assert.equal(turn.toolResults()[0].status, "refused");
  const history = await session.history();
  const starts = history.filter(e => e.kind === "toolStarted");
  const results = history.filter(e => e.kind === "toolResult");
  assert.equal(starts.length, 9);
  assert.equal(results.length, 10);
  assert.deepEqual(results.slice(1).map(e => e.toolCallId), starts.reverse().map(e => e.toolCallId));
});

test("cancelling a turn cancels and settles the dispatched child before the parent", async t => {
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const child = tool({ name: "child", description: "Wait", input: empty, async run(_input, cx) {
    started();
    await delay(10_000, undefined, { signal: cx.cancelled });
  } });
  const parent = tool({ name: "parent", description: "Wait on child", input: empty,
    async run(_input, cx) { return cx.tools.call("child", {}); } });
  const agent = await testAgent({ tools: [child], plugins: [overWire(definePlugin({ name: "caller", tools: [parent] }))], script: [question] });
  t.after(() => agent.close());
  const session = await agent.session();
  const pending = session.prompt("Try it");
  await ready;
  await session.cancel();
  assert.equal((await pending).outcome?.kind, "cancelled");
  const results = (await session.history()).filter(e => e.kind === "toolResult");
  assert.deepEqual(results.map(e => [e.message?.role === "toolResult" && e.message.toolName, (e.data as { status?: unknown })?.status]), [["child", "cancelled"], ["parent", "cancelled"]]);
});

test("structured prompt result rejects a mismatched value, then checks a new attempt including JSON null", async t => {
  const candidates: unknown[] = [];
  const plugin = definePlugin({ name: "result-gate", hooks: { "turn.result": ({ result }) => { candidates.push(result.value); } } });
  const agent = await testAgent({ script: [{ text: "not JSON" }, { text: '"wrong"' }, { text: "null" }], plugins: [overWire(plugin)] });
  t.after(() => agent.close());
  const session = await agent.session({ settings: { maxSteps: 3 } });
  const result = await session.prompt("Return null", { result: { type: "null" } });
  assert.equal(result.outcome?.kind, "completed");
  assert.equal(result.value, null);
  assert.equal((await session.lastTurn())?.value, null);
  assert.deepEqual(candidates, [null]);
  assert.equal((await session.history()).filter(e => e.kind === "resultFeedback").length, 2);
});
