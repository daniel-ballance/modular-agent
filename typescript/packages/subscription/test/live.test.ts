import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "@modular-agent/core";
import { memoryEnvironment } from "@modular-agent/core/testing";
import { chatgpt, subscriptionLogins } from "@modular-agent/subscription";

test("live ChatGPT plan returns text", { skip: process.env.MODULAR_AGENT_LIVE !== "1" || !process.env.MODULAR_AGENT_LIVE_LOGINS }, async t => {
  const p = chatgpt({ logins: subscriptionLogins(process.env.MODULAR_AGENT_LIVE_LOGINS!) });
  if (!await p.available()) { t.skip("No ChatGPT login"); return; }
  const model = process.env.MODULAR_AGENT_LIVE_CHATGPT_MODEL || "gpt-6.1-sol";
  const agent = await createAgent({ providers: [p], model: `chatgpt/${model}`, environment: memoryEnvironment() });
  t.after(() => agent.close());
  const reply = await (await agent.session()).prompt("Say hello in one short sentence.");
  assert.equal(reply.outcome?.kind, "completed");
  assert.ok(reply.text?.trim());
});
