import assert from "node:assert/strict";
import test from "node:test";
import { createAgent, definePlugin, tool, type AssistantMessage } from "@modular-agent/core";
import { memoryEnvironment, overWire } from "@modular-agent/core/testing";
import { claude } from "@modular-agent/claude";
import { createFake } from "../testing/fake-sdk.js";

for (const served of [false, true]) {
  const placement = served ? "served" : "in process";
  test(`claude uses host tools and streams reasoning (${placement})`, async t => {
    const fake = createFake(), replies: AssistantMessage[] = [];
    const p = claude({ test: { query: fake.query, loginVisible: () => true, env: {} } });
    assert.equal(await p.available(), true);
    assert.equal(p.models().find(m => m.id === "claude-haiku-5-5")?.contextWindow, 200_000);
    const plugin = definePlugin({ name: "claude-fixture", setup: r => r.provider(p), stop: p.close });
    let runs = 0;
    const weather = tool({ name: "get_weather", description: "Get the weather", input: { type: "object", properties: { city: { type: "string" } } },
      readOnly: true, run() { runs++; return "Clear"; } });
    const gate = definePlugin({ name: "claude-fixture-hooks", setup: r => {
      r.on("provider.request", ({ request }) => ({ change: { ...request, systemPrompt: "Fixture prompt" } }));
      r.on("provider.response", ({ message }) => { replies.push(message); });
      r.on("step.after", () => ({ end: "Stop after the fixture's first model request" }));
    } });
    const agent = await createAgent({ tools: [weather], environment: memoryEnvironment(), plugins: [served ? overWire(plugin) : plugin, gate] });
    t.after(() => agent.close());
    const session = await agent.session({ settings: { model: "claude/claude-haiku-5-5", thinking: "low" } });
    let reasoning = "";
    for await (const e of session.promptStream("[fake:tool] Weather?")) if (e.type === "reasoning") reasoning += e.data.delta;
    assert.equal(reasoning, "pondering");
    assert.equal(replies[0].stop, "toolUse");
    assert.ok(runs <= 1); // A host run is allowed; no Agent SDK handler can run this tool.
    const options = fake.log.started.at(-1)!;
    assert.equal(options.effort, "low");
    assert.equal(options.systemPrompt, "Fixture prompt");
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.tools, []);
    assert.match(JSON.stringify(replies[0].content), /get_weather/);
    assert.equal(fake.log.closed, fake.log.started.length);
  });
}

test("claude reports an API key source without sending a prompt", async () => {
  const fake = createFake({ subscriptionType: "max", apiKeySource: "user" });
  const p = claude({ test: { query: fake.query, loginVisible: () => true, env: {} } });
  try {
    assert.equal(await p.available(), false);
    assert.match(p.unavailableReason() ?? "", /API key from user/);
    assert.deepEqual(fake.log.prompts, []);
  } finally { p.close(); }
});

test("live Claude plan returns text", { skip: process.env.MODULAR_AGENT_LIVE !== "1" || !process.env.MODULAR_AGENT_LIVE_LOGINS }, async t => {
  const p = claude();
  t.after(p.close);
  if (!await p.available()) { t.skip(p.unavailableReason()); return; }
  const model = process.env.MODULAR_AGENT_LIVE_CLAUDE_MODEL || "claude-haiku-5-5";
  const agent = await createAgent({ providers: [p], model: `claude/${model}`, environment: memoryEnvironment(), settings: { maxOutput: 128 } });
  t.after(() => agent.close());
  const reply = await (await agent.session()).prompt("Say hello in one short sentence.");
  assert.equal(reply.outcome?.kind, "completed");
  assert.ok(reply.text?.trim());
});
