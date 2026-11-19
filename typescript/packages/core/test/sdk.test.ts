import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent, definePlugin, tool, type ToolContext, type Plugin } from "@modular-agent/core";
import { overWire, scriptedProvider, testAgent } from "@modular-agent/core/testing";

const request = (name: string, input: Record<string, unknown> = {}) =>
  [{ toolCalls: [{ name, input }] }, { text: "Done." }];
const input = { type: "object", properties: {}, additionalProperties: false } as const;

test("start failures stop the composition; environment programs are opt-in", async t => {
  const script = [{ text: "Hello." }];
  const prior = process.env.MODULAR_AGENT_PLUGINS;
  process.env.MODULAR_AGENT_PLUGINS = JSON.stringify([{ command: ["/nonexistent/ma-sdk-test"] }]);
  t.after(() => {
    if (prior === undefined) delete process.env.MODULAR_AGENT_PLUGINS;
    else process.env.MODULAR_AGENT_PLUGINS = prior;
  });
  const embedded = await testAgent({ script });
  t.after(() => embedded.close());
  assert.equal((await (await embedded.session()).prompt("Hi")).text, "Hello.");
  await assert.rejects(testAgent({ script, pluginHost: true }), { code: "invalid_composition" });
  await assert.rejects(testAgent({ script, pluginHost: false, processPlugins: [{ command: [process.execPath, "-e", "process.exit(0)"] }] }),
    { code: "invalid_composition" });
  await assert.rejects(testAgent({ script, durability: "kept" }), { code: "invalid_composition" });
  await assert.rejects(testAgent({ script, durability: "durable" }), { code: "invalid_composition" });
});

test("a refusal has identical status and wording in both placements", async t => {
  const blocker = definePlugin({ name: "blocker", tools: [tool({
    name: "blocked", description: "Always refuses.", input,
    run(_input, cx) { cx.refuse("The quay is closed."); },
  })] });
  const result = [];
  for (const plugin of [blocker, overWire(blocker)]) {
    const a = await testAgent({ script: request("blocked"), plugins: [plugin] });
    t.after(() => a.close());
    const r = (await (await a.session()).prompt("Try it.")).toolResults()[0];
    result.push([r.status, r.text()]);
  }
  assert.deepEqual(result, [["refused", "The quay is closed."], ["refused", "The quay is closed."]]);
});

test("a servable command and hooks keep their meaning on stdio", async t => {
  const p = definePlugin({ name: "example", tools: [tool({ name: "echo", description: "Echo", input, run: () => "old" })],
    setup(r) {
      r.command("hello", "Say hello", async (arg, cx) => {
        assert.ok((await cx.history()).entries.length > 0);
        return `hello ${arg}`;
      });
      r.on("turn.before", () => ({ add: { system: "from hook" } }));
      r.on("tool.after", () => ({ change: { content: [{ type: "text", text: "new" }] } }));
      r.on("step.after", ({ response }) => response.stop === "finished" ? { end: "step stopped" } : undefined);
      r.on("turn.end", (_p, cx) => cx.emit("example.ended", { done: true }));
    } });
  for (const plugin of [p, overWire(p)]) {
    const a = await testAgent({ script: request("echo"), plugins: [plugin] });
    t.after(() => a.close());
    const s = await a.session();
    assert.equal((await s.prompt("/hello there")).disposition, "handled");
    const turn = await s.prompt("Echo");
    assert.equal(turn.toolResults()[0].text(), "new");
    assert.deepEqual(turn.outcome, { kind: "failed", error: "step stopped" });
    assert.equal((await s.history()).find(e => e.kind === "turnStart")?.data && ((await s.history()).find(e => e.kind === "turnStart")!.data as { system: string }).system, "from hook");
  }
});

test("serve refuses a flagged tool instead of serving a subset", async () => {
  const plugin = definePlugin({ name: "private", tools: [tool({ name: "secret", description: "Needs a named credential", input, inProcessOnly: true, run: () => "should not run" })] });
  await assert.rejects(testAgent({ script: request("secret"), plugins: [overWire(plugin)] }), /cannot serve tool secret/);
});

test("registration replaces a tool, not the rest of its plugin", async t => {
  const first = (name: string) => tool({ name, description: name, input, run: () => "first" });
  const original = definePlugin({ name: "original", tools: [first("keep"), first("replace")] });
  const replacement = definePlugin({ name: "replacement", replaces: ["tool:replace"],
    tools: [tool({ name: "replace", description: "replacement", input, run: () => "second" })] });
  const script = [{ toolCalls: [{ name: "keep", input: {} }, { name: "replace", input: {} }] }, { text: "Done." }];
  const a = await testAgent({ script, plugins: [original, replacement] });
  t.after(() => a.close());
  assert.deepEqual((await (await a.session()).prompt("Run both.")).toolResults().map(r => r.text()), ["first", "second"]);
  await assert.rejects(testAgent({ script, plugins: [original, { ...replacement, replaces: [] }] }), { code: "invalid_composition" });
  await assert.rejects(testAgent({ script, plugins: [{ ...replacement, replaces: ["tool:missing"] }] }), { code: "invalid_composition" });
});

test("plain JSON Schema validates changed inputs; hints stay as set", async t => {
  const typed = tool({ name: "typed", description: "Accept a short string",
    input: { type: "object", properties: { text: { type: "string", minLength: 2 } }, required: ["text"] },
    readOnly: true, destructive: true, openWorld: false, run: ({ text }) => text.toUpperCase() });
  const base = scriptedProvider(request("typed", { text: "x" }));
  const a = await createAgent({ tools: [typed], providers: [{ ...base, request(model, req, cx) {
    assert.equal(req.tools[0].parameters.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.deepEqual(req.tools[0].hints, { readOnly: true, destructive: true, openWorld: false, safeToRepeat: false });
    return base.request(model, req, cx);
  } }] });
  t.after(() => a.close());
  const r = (await (await a.session()).prompt("Call it.")).toolResults()[0];
  assert.equal(r.status, "failed");
  assert.match(r.text(), /fewer than 2/);
});

test("a tool can decline and its context expires", async t => {
  let captured: ToolContext | undefined;
  const plugin: Plugin = definePlugin({ name: "question", tools: [tool({
    name: "question", description: "Ask something", input, async run(_, cx) {
      captured = cx;
      assert.equal(cx.actorId, "user");
      const answer = await cx.ask({ kind: "text", question: "Name?" });
      return typeof answer === "object" && "declined" in answer ? answer.reason : "not declined";
    },
  })] });
  const a = await testAgent({ script: request("question"), plugins: [plugin], onQuestion: () => ({ declined: true, reason: "no thanks" }) });
  t.after(() => a.close());
  const r = (await (await a.session()).prompt("Ask.")).toolResults()[0];
  assert.equal(r.status, "completed");
  assert.equal(r.text(), "no thanks");
  assert.throws(() => captured?.progress("late"), { code: "invalid_request" });
});

test("concurrent prompts follow their own turns; settings and fork are independent", async t => {
  const a = await testAgent({ script: [{ text: "First." }, { text: "Second." }] });
  t.after(() => a.close());
  const s = await a.session();
  const [first, second] = await Promise.all([s.prompt("one", { key: "1" }), s.prompt("two")]);
  assert.equal(first.text, "First.");
  assert.equal(second.text, "Second.");
  assert.equal((await s.prompt("ignored", { key: "1" })).turnId, first.turnId);
  await s.setSetting("maxSteps", 4);
  const fork = await s.fork();
  await fork.setSetting("maxSteps", 3);
  assert.equal(s.settings().maxSteps, 4);
  assert.equal(fork.settings().maxSteps, 3);
  await fork.close();
  await assert.rejects(fork.prompt("closed"), { code: "not_open" });
});

test("the guide stream yields live text and ends with turnEnded", async t => {
  const a = await testAgent({ script: [{ text: "Whitby." }] });
  t.after(() => a.close());
  const session = await a.session();
  const events = [];
  for await (const event of session.promptStream("Describe Whitby harbour in two sentences.")) {
    events.push(event.type);
    if (event.type === "text") assert.equal(event.data.delta, "Whitby.");
  }
  assert.ok(events.includes("text"));
  assert.equal(events.at(-1), "turnEnded");
});
