import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { tool } from "../src/index.js";
import { restart, testAgent } from "../src/testing.js";

for (const [durability, expected] of [["kept", "failed"], ["durable", "completed"]] as const) {
  test(`reopens an interrupted ${durability} session`, { timeout: 10_000 }, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), "guide05-"));
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let starts = 0;
    const lookup = tool({
      name: "lookup_tide",
      description: "Read the tide time.",
      input: { type: "object" } as const,
      readOnly: true,
      safeToRepeat: true,
      async run(_, cx) {
        if (++starts === 1) {
          started();
          await delay(60_000, undefined, { signal: cx.cancelled });
        }
        return "14:02";
      },
    });
    let agent: Awaited<ReturnType<typeof testAgent>> | undefined;
    try {
      agent = await testAgent({
        dataDir, durability, tools: [lookup],
        script: [
          { toolCalls: [{ name: "lookup_tide", input: {} }] },
          { text: "The tide time could not be confirmed." },
        ],
      });
      const session = await agent.session();
      const id = session.id;
      await session.send("Find the tide time.", "now");
      await Promise.race([ready, delay(5000, undefined, { signal: t.signal, ref: false })
        .then(() => assert.fail("the tool must start before the crash"))]);

      agent = await restart(agent);
      const reopened = await agent.openSession(id);
      const turn = await reopened.lastTurn();
      assert.ok(turn);
      assert.equal(turn.outcome?.kind, expected);
      assert.equal(turn.toolResults()[0].status, "outcomeUnknown");
      assert.equal(starts, 1);
    } finally {
      await agent?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
