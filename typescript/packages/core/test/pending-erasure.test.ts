import assert from "node:assert/strict";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { testAgent } from "@modular-agent/core/testing";

test("pending marks follow forks across held writers and survive restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-pending-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { project: dir, dataDir: dir, durability: "kept" as const, script: [{ text: "Derived" }] };
  const a = await testAgent(config);
  const b = await testAgent(config);
  t.after(() => Promise.all([a.close(), b.close()]));
  const origin = await a.session();
  await origin.prompt("Please erase this", { key: "once" });
  const copies = await origin.fork();
  const second = await copies.fork();
  const firstId = copies.id, secondId = second.id;
  await copies.close();
  await second.close();
  const held = await b.openSession(firstId);
  const heldAgain = await b.openSession(secondId);
  const original = (await origin.history()).find(e => e.kind === "input")!;
  const report = await origin.erase([original.id, original.id]);
  assert.ok(report.erased.some(copy => copy.sessionId === origin.id && copy.id === original.id));
  for (const sid of [firstId, secondId]) assert.ok(report.pending.some(copy => copy.sessionId === sid));
  await assert.rejects(held.fork(), { code: "unavailable" });
  const originId = origin.id;
  await a.close();
  await b.close();

  const c = await testAgent(config);
  t.after(() => c.close());
  for (const sid of [held.id, heldAgain.id]) {
    const takenOver = await c.openSession(sid);
    const entries = await takenOver.history();
    assert.doesNotMatch(JSON.stringify(entries), /Please erase this|Derived/);
    assert.equal(entries.filter(entry => entry.kind === "erasure").length, 1);
    assert.ok(entries.some(entry => entry.erased));
  }
  const resumed = await c.openSession(originId);
  assert.deepEqual(await resumed.send("Never process this", "now", { key: "once" }), { duplicate: true, erased: true });
  const current = await resumed.erase([original.id]);
  assert.equal(current.pending.length, 0);
  assert.equal(current.erased.length, report.erased.length + report.pending.length);
  assert.equal((await resumed.history()).filter(entry => entry.kind === "erasure").length, 1);
});

test("loss of the local freshness source fails closed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-erasure-freshness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = await testAgent({ project: dir, dataDir: dir, durability: "kept", script: [{ text: "private" }] });
  t.after(() => agent.close());
  const session = await agent.session();
  await session.prompt("private");
  await rename(join(dir, "history", "pending-erasure.sqlite"), join(dir, "saved-registry"));
  try {
    await assert.rejects(session.history(), { code: "unavailable" });
    await assert.rejects(session.send("Try another input", "now"), { code: "unavailable" });
  } finally { await rename(join(dir, "saved-registry"), join(dir, "history", "pending-erasure.sqlite")); }
});
