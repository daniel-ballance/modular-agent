import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "@modular-agent/core";
import { memoryEnvironment } from "@modular-agent/core/testing";
import { chatgpt, grok, subscriptionLogins } from "@modular-agent/subscription";

const path = process.env.MODULAR_AGENT_LIVE_LOGINS;
for (const [id, make, modelVariable, defaultModel] of [
  ["chatgpt", chatgpt, "MODULAR_AGENT_LIVE_CHATGPT_MODEL", "gpt-6.1-sol"],
  ["grok", grok, "MODULAR_AGENT_LIVE_GROK_MODEL", "grok-4.7"],
] as const) {
  test(`live ${id} plan returns text`, { skip: process.env.MODULAR_AGENT_LIVE !== "1" || !path }, async t => {
    const p = make({ logins: subscriptionLogins(path!) });
    if (!await p.available()) { t.skip(`No ${id} login`); return; }
    const model = process.env[modelVariable] || defaultModel;
    const agent = await createAgent({ providers: [p], model: `${id}/${model}`, environment: memoryEnvironment() });
    t.after(() => agent.close());
    const reply = await (await agent.session()).prompt("Say hello in one short sentence.");
    assert.equal(reply.outcome?.kind, "completed");
    assert.ok(reply.text?.trim());
  });
}
