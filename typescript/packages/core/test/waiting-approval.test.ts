import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tool } from "../src/index.js";
import { testAgent } from "../src/testing.js";

test("only a handle that received the waiting approval can allow the unstarted call", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ma-approval-"));
  let effects = 0;
  const agent = await testAgent({ durability: "kept", dataDir, approval: "all", questionsOutlastTurns: true,
    maxApprovalWaitMs: 60_000, severalActors: true, tools: [tool({ name: "bump", description: "Increment the counter", input: { type: "object" },
      run: () => String(++effects) })], script: [{ toolCalls: [{ name: "bump", input: { by: 1 } }] }, { text: "Done" }] });
  try {
    assert.equal(agent.declaration().approvalsOutlastTurns, true);
    const session = await agent.session({ settings: { approvalWait: "untilDeadline" }, actors: [{ id: "reviewer", kind: "user", rights: ["watch", "approve"] }] });
    const origin = await session.prompt("Increment the counter");
    await session.waitIdle();
    const [id] = origin.openToolCalls;
    assert.ok(id);
    assert.equal(effects, 0);
    const handle = session.as("reviewer");
    const [q] = await handle.questions();
    assert.equal(q.approvalWait, "untilDeadline");
    assert.deepEqual(q.call?.input, { by: 1 });
    await assert.rejects(handle.answer(q.id, "allow"));
    assert.deepEqual(await handle.questions({ present: true }), [q]);
    await assert.rejects(session.as("reviewer").answer(q.id, "allow"));
    await handle.answer(q.id, "allow");
    await session.waitIdle();
    assert.equal(effects, 1);
    const history = await session.history();
    const start = history.find(e => e.kind === "toolStarted");
    const continuation = history.find(e => e.kind === "turnStart" && e.continuesTurnId === origin.turnId);
    assert.ok(start && continuation);
    assert.equal(start.turnId, continuation.turnId);
    assert.equal(start.toolCallId, id);
    assert.equal(history.filter(e => e.kind === "inputAccepted").length, 1);
  } finally { await agent.close(); await rm(dataDir, { recursive: true, force: true }); }
});
