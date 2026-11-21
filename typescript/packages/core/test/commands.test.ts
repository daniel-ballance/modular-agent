import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, tool, type CommandContext, type ModelRequest } from "@modular-agent/core";
import { overWire, scriptedProvider, testAgent } from "@modular-agent/core/testing";

const request = (): ModelRequest => ({ systemPrompt: "command", messages: [{ role: "user", content: [{ type: "text", text: "Summarize" }] }], tools: [], settings: {} });

test("command model requests use the session Provider, record usage and never dispatch tools or start a turn", async t => {
  const p = scriptedProvider([]);
  p.id = "command-model";
  const models = p.models();
  p.models = () => models.map(m => ({ ...m, provider: p.id }));
  let calls = 0, dispatched = 0;
  const pieces: string[] = [], responses: string[] = [];
  p.request = (model, req, cx) => {
    assert.equal(model.id, p.models()[0].id);
    assert.equal(req.systemPrompt, "by hook");
    assert.equal(req.providerTools, "none");
    assert.equal(req.settings.maxOutput, 64);
    cx.piece("text", `piece ${++calls}`);
    return { role: "assistant", stop: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
      content: [{ type: "toolCall", id: `call-${calls}`, name: "effect", arguments: {} }] };
  };
  let saved!: CommandContext;
  const plugin = definePlugin({ name: "summary", setup(r) {
    r.on("provider.request", ({ request }) => ({ change: { ...request, systemPrompt: "by hook" } }));
    r.on("provider.piece", ({ piece }) => { pieces.push(piece.delta); });
    r.on("provider.response", ({ message }) => { responses.push(message.stop); });
    r.command("summary", "Summarize", async (_, cx) => {
      saved = cx;
      assert.deepEqual((await cx.requestModel(request())).content.map(p => p.type), ["toolCall"]);
      assert.deepEqual((await cx.requestModel(request())).content.map(p => p.type), ["toolCall"]);
      await assert.rejects(cx.requestModel(request()), { code: "turn_limit" });
      return "complete";
    }, { usesModel: true, inProcessOnly: true });
  } });
  const agent = await testAgent({ script: [], providers: [p], model: `${p.id}/${models[0].id}`, settings: { maxSteps: 1, maxOutput: 64 }, plugins: [plugin],
    tenants: { team: { rights: ["watch", "input", "tools"], tokens: 4 } },
    tools: [tool({ name: "effect", description: "Must not run", input: { type: "object" }, run() { dispatched++; } })],
  });
  t.after(() => agent.close());
  const s = await agent.session({ tenant: "team" });
  assert.equal(await s.runCommand("/summary"), "complete");
  assert.equal(await s.lastTurn(), undefined);
  assert.equal(dispatched, 0);
  assert.equal(calls, 2);
  assert.deepEqual(pieces, ["piece 1", "piece 2"]);
  assert.deepEqual(responses, ["toolUse", "toolUse"]);
  await assert.rejects(saved.requestModel(request()), { code: "invalid_request" });
  const entries = (await s.history()).filter(e => ["modelRequest", "response", "turnStart", "toolStarted"].includes(e.kind));
  assert.deepEqual(entries.map(e => e.kind), ["modelRequest", "response", "modelRequest", "response"]);
  assert.ok(saved.stepId);
  for (const e of entries) { assert.equal(e.stepId, saved.stepId); assert.equal(e.turnId, undefined); }
  assert.deepEqual(entries[1].sources, [entries[0].id]);
  assert.deepEqual(entries[3].sources, [entries[2].id]);
  assert.equal(entries[3].message?.role === "assistant" && entries[3].message.usage?.output, 1);
  assert.equal((await s.prompt("Now a turn")).outcome?.kind, "limit");
});

test("a model command cannot be served and a plain command cannot request a model", async t => {
  const plugin = definePlugin({ name: "summary", setup(r) {
    r.command("summary", "Summarize", () => "unused", { usesModel: true, inProcessOnly: true });
  } });
  await assert.rejects(testAgent({ script: [], plugins: [overWire(plugin)] }), { message: /cannot serve command summary/ });
  const agent = await testAgent({ script: [], plugins: [definePlugin({ name: "plain", setup(r) {
    r.command("plain", "No model", async (_, cx) => { await assert.rejects(cx.requestModel(request()), { code: "not_supported" }); });
  } })] });
  t.after(() => agent.close());
  assert.equal(await (await agent.session()).runCommand("/plain"), undefined);
});
