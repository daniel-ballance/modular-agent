import { tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

test("says hello", async () => {
  const agent = await testAgent({ script: [{ text: "Hello." }] });
  const turn = await (await agent.session()).prompt("Say hello.");
  assert.equal(turn.text, "Hello.");
});

export const tide = tool({
  name: "tide",
  description: "Today's high tide at a harbour.",
  input: z.object({ harbour: z.string().describe("The harbour to look up.") }),
  readOnly: true,
  run: async ({ harbour }) => `High tide at ${harbour} is 14:02.`,
});

test("looks up the tide", async () => {
  const agent = await testAgent({
    tools: [tide],
    script: [
      { toolCalls: [{ name: "tide", input: { harbour: "Whitby" } }] },
      { text: "High tide is at 14:02." },
    ],
  });
  const turn = await (await agent.session()).prompt("When is high tide at Whitby?");
  assert.equal(turn.text, "High tide is at 14:02.");
  const [result] = turn.toolResults();
  assert.equal(result.status, "completed");
  assert.equal(result.text(), "High tide at Whitby is 14:02.");
});
