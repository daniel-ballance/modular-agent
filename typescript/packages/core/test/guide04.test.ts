import assert from "node:assert/strict";
import { test } from "node:test";
import { tool, type Answer, type Question } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { z } from "zod";

test("checks approval policy", { timeout: 5000 }, async () => {
  for (const [approval, readOnly, hasHandler, status, asks] of [
    ["off", false, true, "completed", 0],
    ["ask", true, false, "completed", 0],
    ["ask", false, false, "refused", 0],
    ["ask", false, true, "completed", 1],
    ["all", true, true, "completed", 1],
    ["never", false, true, "refused", 0],
  ] as const) {
    const seen: Question[] = [];
    const agent = await testAgent({
      approval,
      tools: [tool({
        name: "preview", description: "Preview a palette.", readOnly,
        input: z.object({}), run: async () => "Preview ready.",
      })],
      onQuestion: hasHandler ? question => { seen.push(question); return "allow"; } : undefined,
      script: [{ toolCalls: [{ name: "preview", input: {} }] }, { text: "Done." }],
    });
    try {
      const turn = await (await agent.session()).prompt("Preview a palette.");
      assert.equal(turn.toolResults()[0].status, status);
      assert.deepEqual(seen.map(q => [q.kind, q.call?.name, q.call?.input]),
        Array.from({ length: asks }, () => ["approval", "preview", {}]));
    } finally {
      await agent.close();
    }
  }
});

const choosePalette = tool({
  name: "choose_palette",
  description: "Ask which palette to preview.",
  readOnly: true,
  input: z.object({}),
  run: async (_, cx) => {
    const answer = await cx.ask({
      kind: "choice", question: "Which palette?", options: ["light", "dark"],
    });
    if (typeof answer === "object" && "value" in answer) return `Selected ${answer.value}.`;
    return cx.refuse("No palette selected.");
  },
});

test("answers a choice from the UI", { timeout: 5000 }, async () => {
  const agent = await testAgent({
    approval: "ask",
    onQuestion: () => "decline",
    tools: [choosePalette],
    script: [{ toolCalls: [{ name: "choose_palette", input: {} }] }, { text: "Done." }],
  });
  try {
    const session = await agent.session();
    let respond!: (answer: Answer) => void;
    const reply = new Promise<Answer>(resolve => { respond = resolve; });
    const shown = new Promise<Question>(resolve => {
      session.onQuestion(question => {
        resolve(question);
        return reply;
      });
    });

    const turn = session.prompt("Choose a palette.");
    const question = await Promise.race([
      shown,
      turn.then(() => { throw new Error("Turn ended without a question"); }),
    ]);
    try {
      assert.equal(question.sessionId, session.id);
      assert.equal(question.kind, "choice");
      assert.deepEqual(question.options, ["light", "dark"]);
    } finally {
      // The app's click handler settles the promise returned by onQuestion.
      respond({ value: "dark" });
    }
    assert.equal((await turn).toolResults()[0].text(), "Selected dark.");
  } finally {
    await agent.close();
  }
});
