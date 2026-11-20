import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, tool } from "../src/index.js";
import { overWire, restart, testAgent } from "../src/testing.js";

for (const served of [false, true]) {
  test(`a tool starts an owned job, which ${served ? "cancels on close" : "resumes before reopen returns"}`, { timeout: 5000 }, async () => {
    const resumed: string[] = [];
    const cancelled: string[] = [];
    const plugin = definePlugin({ name: "lookup-job", setup(r) {
      r.jobs({
        async resume(job, cx) {
          resumed.push(job.id);
          assert.deepEqual(job.detail, { harbour: "Whitby" });
          await cx.job.end({ kind: "completed" }, "14:02", true);
        },
        async cancel(job, cx) {
          cancelled.push(job.id);
          await cx.job.end({ kind: "cancelled" });
        },
      });
      r.tool(tool({ name: "lookup", description: "Start a tide lookup", input: { type: "object" }, async run(_, cx) {
        const job = await cx.jobs.start("lookup", { harbour: "Whitby" }, "tide");
        job.progress("Started lookup");
        const duplicate = await cx.jobs.start("lookup", {}, "tide");
        assert.equal(duplicate.id, job.id);
        assert.equal(duplicate.started, false);
        return job.id;
      } }));
    } });
    let agent = await testAgent({ plugins: [served ? overWire(plugin) : plugin],
      script: [{ toolCalls: [{ name: "lookup", input: {} }] }, { text: "Searching." }] });
    try {
      const session = await agent.session();
      const turn = await session.prompt("Find the tide.");
      const [result] = turn.toolResults();
      assert.equal(result?.status, "completed", result?.text());
      const jobId = result.text();
      if (served) await session.close();
      else agent = await restart(agent);
      const history = await (await agent.openSession(session.id)).history();
      assert.deepEqual(resumed, served ? [] : [jobId]);
      assert.deepEqual(cancelled, served ? [jobId] : []);
      assert.equal(history.filter(e => e.kind === "jobStarted" && e.jobId === jobId).length, 1);
      const ends = history.filter(e => e.kind === "jobEnded" && e.jobId === jobId);
      assert.equal(ends.length, 1);
      assert.equal((ends[0].data as { outcome: { kind: string } }).outcome.kind, served ? "cancelled" : "completed");
      assert.equal(history.filter(e => e.kind === "inputAccepted" && e.jobId === jobId).length, served ? 0 : 1);
      assert.equal(history.filter(e => e.kind === "turnStart").length, 1, "the report is parked by default");
    } finally { await agent.close(); }
  });
}
