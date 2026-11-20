import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, tool } from "@modular-agent/core";
import { overWire, testAgent } from "@modular-agent/core/testing";
import { z } from "zod";

function tidePreview(recordEnd: (kind: string) => void) {
  return definePlugin({
    name: "tide-preview",
    setup(r) {
      r.on("turn.before", () => ({ add: { system: "Give the local time." } }));
      r.on("turn.before", () => ({ add: { system: "Keep the report short." } }), "last");
      r.on("turn.before", () => ({ add: { system: "Report high tides." } }), "first");
      r.on("tool.before", ({ call }) => {
        if (call.name !== "preview_tide") return;
        if (call.input.harbour === "closed") return { refuse: "That station is closed." };
        if (call.input.harbour === "old-town") return { change: { harbour: "Whitby" } };
      });
      r.on("tool.after", ({ call, result }) => {
        if (call.name !== "preview_tide" || result.status !== "completed") return;
        const text = result.content[0]?.text;
        return { change: { content: [{ type: "text", text: `Preview: ${text}` }] } };
      });
      r.on("step.after", () => ({ end: "Preview stops after one step." }));
      r.on("turn.end", ({ outcome }) => recordEnd(outcome.kind));
    },
  });
}

test("previews tides in process and served", { timeout: 5000 }, async () => {
  for (const served of [false, true]) {
    const ended: string[] = [];
    const plugin = tidePreview(kind => { ended.push(kind); });
    const agent = await testAgent({
      plugins: [served ? overWire(plugin) : plugin],
      tools: [tool({
        name: "preview_tide", description: "Find a high tide.", readOnly: true,
        input: z.object({ harbour: z.string() }),
        run: async ({ harbour }) => `${harbour}: 14:02`,
      })],
      script: [
        { toolCalls: [
          { name: "preview_tide", input: { harbour: "old-town" } },
          { name: "preview_tide", input: { harbour: "closed" } },
        ] },
        { text: "This step must not run." },
      ],
    });
    try {
      const session = await agent.session();
      const turn = await session.prompt("Preview the high tides.");
      const [completed, refused] = turn.toolResults();
      assert.equal(completed.status, "completed");
      assert.equal(completed.text(), "Preview: Whitby: 14:02");
      assert.equal(refused.status, "refused");
      assert.match(refused.text(), /That station is closed\./);
      assert.equal(turn.outcome?.kind, "failed");
      assert.match(turn.outcome.error, /Preview stops after one step\./);
      assert.equal(turn.text, "");
      const start = (await session.history()).find(entry => entry.kind === "turnStart");
      assert.deepEqual((start?.data as { system: string }).system.split(/\n+/),
        ["Report high tides.", "Give the local time.", "Keep the report short."]);
      assert.deepEqual(ended, ["failed"]);
    } finally {
      await agent.close();
    }
  }
});
