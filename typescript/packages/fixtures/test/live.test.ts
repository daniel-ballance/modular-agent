import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropic } from "@modular-agent/anthropic";
import { createAgent } from "@modular-agent/core";
import { openai } from "@modular-agent/openai";
import { tide } from "../src/index.js";

const enabled = process.env.MODULAR_AGENT_LIVE === "1";
for (const [make, key, modelVar, fallback] of [
  [openai, "OPENAI_API_KEY", "MODULAR_AGENT_LIVE_OPENAI_MODEL", "gpt-6-luna"],
  [anthropic, "ANTHROPIC_API_KEY", "MODULAR_AGENT_LIVE_ANTHROPIC_MODEL", "claude-haiku-5-5"],
] as const) {
  test(`live Provider: ${key}`, {
    skip: !enabled ? "set MODULAR_AGENT_LIVE=1 to opt in" : !process.env[key] ? `${key} is absent` : false,
    timeout: 120_000,
  }, async () => {
    const provider = make();
    const id = process.env[modelVar] ?? fallback;
    const info = provider.models().find(m => m.id === id);
    assert.ok(info, `${provider.id}/${id} is not in the installed catalog; choose a model with ${modelVar}`);
    const reasoning = info.thinking?.find(level => level !== "off") ?? (info.reasoning ? "low" : "off");
    const agent = await createAgent({ providers: [provider], model: `${provider.id}/${id}`, tools: [tide],
      settings: { reasoning, maxSteps: 3, maxOutput: 512 } });
    try {
      const session = await agent.session();
      assert.equal(session.settings().reasoning, reasoning);
      const pieces: string[] = [];
      for await (const event of session.promptStream("Reply with just the word Hello.")) {
        if (event.type === "text") pieces.push(event.data.delta);
      }
      const first = await session.lastTurn();
      assert.equal(first?.outcome?.kind, "completed");
      assert.ok(first.text.trim());
      assert.equal(pieces.join(""), first.text);
      const second = await session.prompt("Use the tide tool for Whitby before answering. Include the returned time in your answer.");
      assert.equal(second.outcome?.kind, "completed");
      assert.ok(second.toolResults().some(result => result.name === "tide" && result.status === "completed" && result.text().includes("14:02")));
      assert.match(second.text, /14:02/);
    } finally { await agent.close(); }
  });
}
