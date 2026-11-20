import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, tool } from "../src/index.js";
import { overWire, testAgent } from "../src/testing.js";

const note = definePlugin({ name: "late-note", tools: [tool({
  name: "note", description: "Ask for a note", input: { type: "object" },
  async run(_, cx) {
    const answer = await cx.ask({ kind: "text", question: "A note?" }, { wait: 10, then: "leaveOpen" });
    return typeof answer === "object" && "value" in answer ? answer.value : "declined";
  },
})] });
for (const served of [false, true]) {
  test(`a late answer continues the recorded call (served=${served})`, { timeout: 5000 }, async () => {
    const agent = await testAgent({ questionsOutlastTurns: true, plugins: [served ? overWire(note) : note],
      script: [{ toolCalls: [{ name: "note", input: {} }] }, { text: "Done." }] });
    try {
      const session = await agent.session();
      const first = await session.prompt("Ask for a note.");
      assert.equal(first.outcome?.kind, "completed");
      assert.equal(first.openToolCalls.length, 1);
      const [open] = await session.questions();
      assert.equal(open.kind, "text");
      await session.answer(open.id, { value: "from the UI" });
      await session.waitIdle();
      assert.deepEqual(await session.questions(), []);
      const history = await session.history();
      assert.equal(history.findLast(e => e.kind === "toolResult")?.message?.content[0]?.text, "from the UI");
      assert.equal(history.filter(e => e.kind === "inputAccepted").length, 1);
      assert.equal(history.filter(e => e.kind === "inputRequest").length, 1);
    } finally { await agent.close(); }
  });
}
