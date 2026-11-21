import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, tool, type Content } from "@modular-agent/core";
import { overWire, testAgent } from "@modular-agent/core/testing";

const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
const progress: Content = [{ type: "text", text: "Preview" }, image];

for (const served of [false, true]) {
  test(`${served ? "served" : "in-process"} tool and job progress reach an events follower with images`, { timeout: 5000 }, async t => {
    const plugin = definePlugin({ name: "progress", setup(r) {
      r.jobs({ async cancel(_, cx) { await cx.job.end({ kind: "cancelled" }); } });
      r.tool(tool({ name: "preview", description: "Show a preview", input: { type: "object" }, async run(_, cx) {
        cx.progress(progress);
        cx.progress([image]);
        cx.progress([{ type: "text", text: "Hide this" }, image]);
        const job = await cx.jobs.start("preview", {});
        job.progress(progress);
        await job.end({ kind: "completed" });
        return "ready";
      } }));
    } });
    const seenByGate: unknown[] = [];
    const gate = definePlugin({ name: "observe-progress", hooks: { output({ events, recipient }) {
      if (recipient !== "viewer") return;
      seenByGate.push(...events.filter(e => e.type === "toolOutput").map(e => e.data));
      return { redact: events.map(e => {
        const data = e.data as { chunk?: string };
        return e.type === "toolOutput" && data.chunk === "Hide this" ? { ...e, data: { ...data, chunk: "[redacted]" } } : e;
      }) };
    } } });
    const agent = await testAgent({ severalActors: true, plugins: served ? [overWire(plugin), overWire(gate)] : [plugin, gate],
      script: [{ toolCalls: [{ name: "preview", input: {} }] }, { text: "Done" }] });
    t.after(() => agent.close());
    const session = await agent.session({ actors: [{ id: "viewer", kind: "program", rights: ["watch"] }] });
    const readProgress = async () => {
      const tools: unknown[] = [], jobs: Content[] = [];
      for await (const event of session.as("viewer").events()) {
        if (event.type === "toolOutput") {
          assert.equal(event.data.toolCallId, event.toolCallId);
          tools.push(event.data);
        }
        if (event.type === "jobProgress") jobs.push(event.data.content);
        if (event.type === "turnEnded") return { tools, jobs };
      }
      throw new Error("Session ended before the turn settled");
    };
    const [seen, result] = await Promise.all([readProgress(), session.prompt("Show a preview")]);
    assert.equal(result.toolResults()[0].status, "completed");
    const toolCallId = result.toolResults()[0].callId;
    const unchanged = [{ toolCallId, chunk: "Preview", content: progress }, { toolCallId, chunk: "", content: [image] }];
    assert.deepEqual(seenByGate, [...unchanged, { toolCallId, chunk: "Hide this", content: [{ type: "text", text: "Hide this" }, image] }]);
    assert.deepEqual(seen.tools, [...unchanged, { toolCallId, chunk: "[redacted]", content: [{ type: "text", text: "[redacted]" }, image] }]);
    assert.deepEqual(seen.jobs, [progress]);
  });
}
