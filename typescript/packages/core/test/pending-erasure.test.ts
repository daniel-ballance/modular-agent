import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { definePlugin, fileHistory, httpHistory, serveHistory } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { historyService } from "@modular-agent/services";

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

test("HTTP erasure refuses a history delivery waiting at its output gate", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-http-erasure-"));
  const token = randomBytes(32).toString("hex"), tokenFile = join(dir, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const service = await serveHistory(fileHistory(join(dir, "store")), { address: "127.0.0.1:0", tokenFile });
  let gated!: () => void, resume!: () => void;
  const atGate = new Promise<void>(resolve => { gated = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  let pause = false;
  const a = await testAgent({ durability: "kept", history: httpHistory(service.url, tokenFile), script: [{ text: "private answer" }],
    plugins: [definePlugin({ name: "pause-delivery", setup(registrar) {
      registrar.on("output", async () => { if (pause) { gated(); await release; } });
    } })],
  });
  t.after(async () => { resume(); await a.close(); await service.close(); await rm(dir, { recursive: true, force: true }); });
  const view = await a.session();
  await view.prompt("private input");
  const target = (await view.history()).find(e => e.kind === "input")!.id;
  const request = async <T = unknown>(path: string, method: string, body?: object): Promise<T> => {
    const reply = await fetch(service.url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body && JSON.stringify(body) });
    assert.equal(reply.status, 200);
    return await reply.json() as T;
  };
  const source = "/v1/sessions/source", dest = `/v1/sessions/${view.id}`;
  await request(source, "PUT", { created: Date.now(), project: dir });
  const { lease } = await request<{ lease: string }>(source + "/lease", "POST", { owner: "wire-writer" });
  await request(source + "/entries", "POST", { lease, entries: [{ id: "source-target", parentId: null }] });
  pause = true;
  const refused = assert.rejects(view.history(), { code: "unavailable" });
  await atGate;
  try {
    const { revision } = await request<{ revision: string }>(source + "/pending-erasure", "GET");
    await request(source + "/pending-erasure", "POST", { lease, revision, intentId: "mark", entryIds: ["source-target"],
      copies: [{ sessionId: "source", recordId: "source-book", entryIds: ["source-target"] },
        { sessionId: view.id, recordId: "dest-book", entryIds: [target] }] });
    const { plans } = await request<{ plans: { copies: { complete: boolean }[] }[] }>(dest + "/pending-erasure", "GET");
    assert.equal(plans[0].copies[0].complete, false);
  } finally { resume(); }
  await refused;
});

test("a repeated HTTP erasure recovers a destination that expired after publication", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-http-erasure-expiry-"));
  const cleanup: (() => Promise<void>)[] = [() => rm(dir, { recursive: true, force: true })];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const token = randomBytes(32).toString("hex"), tokenFile = join(dir, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const retention = 60_000;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const service = await historyService({ dir: join(dir, "store"), token, retention });
  cleanup.push(() => new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve())));
  const config = { durability: "kept" as const, history: httpHistory(service.url, tokenFile), script: [{ text: "private answer" }] };
  const first = await testAgent(config);
  cleanup.push(() => first.close());
  const source = await first.session();
  await source.prompt("private input");
  const target = (await source.history()).find(e => e.kind === "input")!.id;
  const dest = await source.fork();
  await dest.close();
  now += retention / 2;
  await source.prompt("keep the source session live");
  const sourcePath = `${service.url}/v1/sessions/${source.id}`;
  const destPath = `${service.url}/v1/sessions/${dest.id}`;
  const publishPath = sourcePath + "/pending-erasure";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const fetchHistory = globalThis.fetch;
  type Publication = { lease: string; revision: string; intentId: string; entryIds: string[]; copies: { sessionId: string }[] };
  let publication: Publication | undefined;
  let published: unknown;
  const fault = t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    const reply = await fetchHistory(...args);
    if (args[0] !== publishPath || args[1]?.method !== "POST") return reply;
    assert.equal(reply.status, 200);
    publication = JSON.parse(args[1].body as string) as Publication;
    published = await reply.json();
    // Stop the first client after the mark commits but before it begins completion.
    return Response.json({ error: "Publication reply lost", code: "unavailable" }, { status: 503 });
  });
  try { await assert.rejects(source.erase([target]), { code: "lost", message: "Publication reply lost" }); }
  finally { fault.mock.restore(); }
  assert.ok(publication);
  const expected = { intentId: publication.intentId, sessionIds: [source.id, dest.id] };
  assert.deepEqual(published, expected);

  now += retention / 2;
  const expired = await fetch(destPath, { headers });
  assert.equal(expired.status, 404);
  assert.equal((await expired.json() as { code: string }).code, "unknown_session");
  // Even with stale revision and reversed copy sets, the original order survives.
  const duplicate = await fetch(publishPath, { method: "POST", headers,
    body: JSON.stringify({ ...publication, copies: [...publication.copies].reverse() }) });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), expected);
  await first.close();

  const recovered = await testAgent(config);
  cleanup.push(() => recovered.close());
  const reopened = await recovered.openSession(source.id);
  const report = await reopened.erase([target]);
  assert.ok(report.erased.some(copy => copy.sessionId === source.id && copy.id === target));
  assert.equal(report.pending.length, 0); // The expired session's authority records are unavailable.
  assert.ok(report.outOfReach.includes("copies in other sessions"));
  const registry = await fetch(destPath + "/pending-erasure", { headers });
  assert.equal(registry.status, 200);
  const { plans } = await registry.json() as { plans: { intentId: string; copies: { complete: boolean }[] }[] };
  assert.equal(plans.length, 1);
  assert.equal(plans[0].intentId, expected.intentId);
  assert.ok(plans[0].copies.every(copy => !copy.complete));
});

test("a previously declared HTTP registry does not recreate missing storage", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-http-missing-registry-"));
  const token = randomBytes(32).toString("hex"), tokenFile = join(dir, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const store = join(dir, "store"), options = { address: "127.0.0.1:0", tokenFile };
  const first = await serveHistory(fileHistory(store), options);
  await first.close();
  await rename(join(store, "history.sqlite"), join(dir, "detached.sqlite"));
  const restarted = await serveHistory(fileHistory(store), options);
  t.after(async () => { await restarted.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${token}` };
  const declaration = await fetch(`${restarted.url}/v1`, { headers });
  assert.equal(declaration.status, 200);
  assert.equal((await declaration.json() as { pendingErasure?: number }).pendingErasure, 1);
  const registry = await fetch(`${restarted.url}/v1/sessions/previous/pending-erasure`, { headers });
  assert.equal(registry.status, 503);
  assert.equal((await registry.json() as { code: string }).code, "unavailable");
});

test("an independent erasure registry fences a restored history backup", async t => {
  const root = await mkdtemp(join(tmpdir(), "sdk-stale-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "history"), backup = join(root, "backup");
  const config = { project: root, durability: "kept" as const,
    history: fileHistory(dir, { pendingErasureDir: join(root, "authority") }), script: [{ text: "Private response" }] };
  const a = await testAgent(config);
  t.after(() => a.close());
  const session = await a.session();
  const id = session.id;
  await session.prompt("Private input", { key: "spent" });
  const input = (await session.history()).find(e => e.kind === "input")!;
  await session.close();
  await cp(dir, backup, { recursive: true });
  const eraser = await a.openSession(id);
  assert.ok((await eraser.erase([input.id])).erased.some(entry => entry.id === input.id));
  await a.close();
  await rm(dir, { recursive: true });
  await rename(backup, dir);
  const restored = await testAgent({ ...config, history: fileHistory(dir, { pendingErasureDir: join(root, "authority") }) });
  t.after(() => restored.close());
  await assert.rejects(restored.openSession(id), { code: "unavailable" });
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
