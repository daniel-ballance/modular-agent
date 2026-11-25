import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { definePlugin, tool, type Event } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { interruptedHistory } from "./fixtures/interrupted-history.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test("an idle kept session reports a revoked writer before another write", { timeout: 5000 }, async t => {
  const { store, revoke } = interruptedHistory();
  const agent = await testAgent({ durability: "kept", history: undefined,
    plugins: [definePlugin({ name: "idle-lease", replaces: ["history"], setup: r => r.historyStore(store) })],
    script: [{ text: "Finished" }],
  });
  t.after(() => agent.close());
  const session = await agent.session();
  assert.equal((await session.prompt("Keep this session")).text, "Finished");
  await session.waitIdle();
  const entries = await session.history();
  const cursor = entries.at(-1)!.id;
  const follower = session.events(cursor)[Symbol.asyncIterator]();
  try {
    const pending = follower.next(); // Subscribes before the store signals loss.
    revoke(session.id);
    const next = await pending;
    assert.equal(next.done, false);
    assert.equal(next.value?.type, "sessionInterrupted");
    assert.equal(next.value?.sessionId, session.id);
    assert.deepEqual(next.value?.data, { reason: "writerLost" });
    assert.equal((await follower.next()).done, true);
    assert.deepEqual(await session.history(), entries);
  } finally { await follower.return?.(); }
});

for (const reason of ["writerLost", "commitFailed"] as const) {
  test(`a session follower sees ${reason} and both waiting prompts fail with lost`, { timeout: 10_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), "ma-interruption-"));
    const { store, revoke, failNextAppend } = interruptedHistory();
    const cancelled = deferred<void>();
    let invocations = 0;
    const hold = tool({ name: "hold", description: "Wait for interruption", input: { type: "object" },
      run: async (_, cx) => {
        invocations++;
        if (!cx.cancelled.aborted) await new Promise<void>(resolve => cx.cancelled.addEventListener("abort", () => resolve(), { once: true }));
        cancelled.resolve();
        return "not a recorded result";
      },
    });
    const agent = await testAgent({ project: dir, durability: "kept", dataDir: dir, tools: [hold],
      plugins: [definePlugin({ name: "lease-fixture", replaces: ["history"], setup: r => r.historyStore(store) })],
      script: [{ toolCalls: [{ name: "hold", input: {} }] }, { text: "After recovery" }],
    });
    t.after(async () => { await agent.close(); await rm(dir, { recursive: true, force: true }); });
    const session = await agent.session();
    const lost = { code: "lost" };
    const started = deferred<void>();
    const queued = deferred<void>();
    const observed = deferred<Event>();
    let admissions = 0;
    const following = (async () => {
      for await (const e of session.events()) {
        if (e.type === "inputAccepted" && ++admissions === 2) queued.resolve();
        if (e.type === "toolStarted") started.resolve();
        if (e.type === "sessionInterrupted") observed.resolve(e);
      }
    })();
    const prompt = assert.rejects(session.prompt("Start a call"), lost);
    await started.promise;
    const stream = assert.rejects((async () => {
      for await (const e of session.promptStream("Do not start this turn")) assert.notEqual(e.type, "turnEnded");
    })(), lost);
    await queued.promise;
    if (reason === "writerLost") revoke(session.id);
    else {
      failNextAppend();
      await assert.rejects(session.setSetting("fixture-fail", true), lost);
    }
    const event = await observed.promise;
    assert.equal(event.sessionId, session.id);
    assert.deepEqual(event.data, { reason });
    await Promise.all([prompt, stream, following, cancelled.promise]);
    await assert.rejects(session.send("Cannot start work", "now"), lost);
    assert.equal(await session.lastTurn(), undefined);
    assert.ok(!(await session.history()).some(e => e.kind === "toolResult"));

    const reopened = await agent.openSession(session.id);
    assert.equal((await reopened.lastTurn())?.outcome?.kind, "failed");
    assert.equal((await reopened.lastTurn())?.toolResults()[0].status, "outcomeUnknown");
    const replay = reopened.events()[Symbol.asyncIterator]();
    try {
      const count = (await reopened.history()).length;
      for (let i = 0; i < count; i++) assert.equal((await replay.next()).value?.type, "entry");
    } finally { await replay.return?.(); }
    assert.equal((await reopened.prompt("Fresh input")).text, "After recovery");
    assert.equal(invocations, 1);
  });
}
