/// <reference lib="es2024.sharedmemory" />
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createAgent, definePlugin, fileHistory, httpHistory, serveHistory, tool, localEnvironment, type Session } from "@modular-agent/core";
import { memoryEnvironment, testAgent } from "@modular-agent/core/testing";
import { filePendingErasure } from "@modular-agent/harness";
import { HistoryArchive, historyService } from "@modular-agent/services";

test("pending marks follow forks across held writers and survive restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-pending-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { project: dir, dataDir: dir, durability: "kept" as const, severalActors: true, script: [{ text: "Derived" }] };
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
  await held.join({ id: "observer", kind: "user", rights: ["watch"] });
  const observer = held.as("observer");
  const original = (await origin.history()).find(e => e.kind === "input")!;
  const report = await origin.erase([original.id, original.id]);
  assert.ok(report.erased.some(copy => copy.sessionId === origin.id && copy.id === original.id));
  for (const sid of [firstId, secondId]) assert.ok(report.pending.some(copy => copy.sessionId === sid));
  await assert.rejects(observer.setSetting("title", "must not retry"), { code: "forbidden" });
  await assert.rejects(observer.runCommand("/bogus"), { code: "forbidden" });
  await assert.rejects(observer.fork(), { code: "forbidden" });
  await assert.rejects(observer.moveTo(original.id), { code: "forbidden" });
  assert.equal((await a.reconcileErasure({ sessions: [firstId] }))[0].state, "busy");
  await observer.leave("observer");
  assert.ok(!(await a.sessions()).some(s => s.id === firstId));
  await assert.rejects(a.sessionInfo(firstId), { code: "unavailable" });
  await held.setSetting("title", "after retry");
  const updated = await held.history();
  assert.ok(updated.findIndex(e => e.kind === "erasure") < updated.findLastIndex(e => e.kind === "setting"));
  const originId = origin.id;
  await a.close();
  await b.close();

  const c = await testAgent(config);
  t.after(() => c.close());
  assert.deepEqual((await c.reconcileErasure({ discover: true })).map(r => [r.sessionId, r.state]), [[secondId, "complete"]]);
  assert.deepEqual(await c.reconcileErasure({ discover: true }), []);
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

test("quiet erasure checks project metadata and tenant setup before reading or writing history", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-erasure-scope-"));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "scope-fixture", { mode: 0o600 });
  const origin = "http://127.0.0.1:14892";
  const project = { id: "foreign-project", project: dir + "/other", created: 1 };
  const tenant = { id: "foreign-tenant", project: dir, created: 1 };
  const setup = { id: "setup", parentId: null, kind: "tenant", data: { tenant: "outside" } };
  const payload = { id: "payload", parentId: "setup", kind: "fixture.private" };
  const trace: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, options?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, origin);
    trace.push(`${options?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/v1") return Response.json({ binding: "modular-agent-history/1", ttlMs: 30_000, pendingErasure: 1 });
    if (url.pathname === "/v1/sessions") return Response.json({ sessions: [project, tenant] });
    const session = [project, tenant].find(meta => url.pathname === `/v1/sessions/${meta.id}`);
    if (!session) return Response.json({ code: "unavailable" }, { status: 503 });
    return Response.json(url.searchParams.get("limit") === "1" ? { session, entries: [setup], next: "setup" } : { session, entries: [setup, payload] });
  });
  const a = await testAgent({ project: dir, durability: "kept", history: httpHistory(origin, tokenFile), script: [] });
  t.after(async () => { await a.close(); await rm(dir, { recursive: true, force: true }); });
  for (const sessionId of [project.id, tenant.id]) {
    trace.length = 0;
    assert.deepEqual(await a.reconcileErasure({ sessions: [sessionId] }), [{ sessionId, state: "outOfScope", erased: [], pending: [] }]);
    assert.deepEqual(trace, ["GET /v1/sessions", ...(sessionId === tenant.id ? ["GET /v1/sessions/foreign-tenant?limit=1"] : [])]);
  }
  trace.length = 0;
  await assert.rejects(a.reconcileErasure({ discover: true }), { code: "unavailable" });
  assert.deepEqual(trace, []);
});

test("answer retries erasure without rebinding a delivered question", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-erasure-answer-"));
  const archive = new HistoryArchive(join(dir, "history")), store = archive.store();
  const a = await testAgent({ project: dir, durability: "kept", script: [{ text: "seed" }],
    plugins: [definePlugin({ name: "answer-fixture", replaces: ["history"], setup(r) { r.historyStore(store); } })] });
  t.after(async () => { await a.close(); await rm(dir, { recursive: true, force: true }); });
  const session = await a.session();
  const id = session.id;
  await session.prompt("seed");
  await session.close();
  const { entries } = await store.load(id);
  const turnId = entries.findLast(e => e.kind === "turnEnd")!.turnId;
  await store.openForWriting(id);
  for (const [requestId, parentId, question] of [["affected", entries.at(-1)!.id, "Private delivered question"], ["unaffected", "affected", "Independent delivered question"]]) {
    await store.append(id, [{ id: requestId, parentId, sessionId: id, time: Date.now(), writer: "fixture", kind: "inputRequest", modelVisible: false, turnId, requestId,
      data: { request: { id: requestId, sessionId: id, kind: "text", question, answerers: ["user"] } } }]);
  }
  await store.close(id);
  const open = await a.openSession(id);
  assert.deepEqual((await open.questions()).map(q => q.id).sort(), ["affected", "unaffected"]);
  const registry = store.pendingErasure!;
  await registry.exclusive(async () => registry.keep({ id: "mark", sessionId: id, actorId: "user", targets: ["affected"], copies: [{ sessionId: id, id: "affected", erased: false }] }));
  await assert.rejects(open.answer("affected", { value: "do not bind" }));
  assert.equal(registry.intents()[0].copies[0].erased, true);
  assert.deepEqual((await open.questions()).map(q => q.id), ["unaffected"]);
  await open.answer("unaffected", { value: "keep this answer" });
  const kept = JSON.stringify((await store.load(id)).entries);
  assert.doesNotMatch(kept, /do not bind|Private delivered question/);
  assert.match(kept, /keep this answer/);
});

const privateRetryInput = "Private retry fixture input";

async function retryFixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-retry-trigger-"));
  const project = join(dir, "project");
  await mkdir(project);
  const store = new HistoryArchive(join(dir, "history")).store();
  const registry = store.pendingErasure!;
  const build = async (options: Parameters<typeof testAgent>[0]) => {
    const agent = await testAgent({ ...options, project, durability: "kept", plugins: [
      definePlugin({ name: "retry-store", replaces: ["history"], setup(r) { r.historyStore(store); } }), ...options.plugins ?? [],
    ] });
    t.after(async () => { try { await agent.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
    return agent;
  };
  async function mark(sessionId: string, targets: string[]) {
    await registry.exclusive(async () => registry.keep({ id: "mark", sessionId, actorId: "user", targets,
      copies: targets.map(id => ({ sessionId, id, erased: false })) }));
    assert.ok(registry.intents()[0].copies.every(copy => !copy.erased));
  }
  async function markPrivate(session: Session) {
    await session.prompt(privateRetryInput);
    const { entries } = await store.load(session.id);
    const target = entries.findLast(e => e.kind === "input")!.id;
    const ids = entries.filter(e => JSON.stringify(e).includes(privateRetryInput)).map(e => e.id);
    assert.ok(ids.includes(target));
    await mark(session.id, ids);
    return target;
  }
  async function reconciled(sessionId: string, target: string) {
    // Read storage directly; Session.history would retry on its own.
    assert.ok(registry.intents()[0].copies.every(copy => copy.erased));
    const { entries } = await store.load(sessionId);
    assert.equal(entries.find(e => e.id === target)?.erased, true);
    assert.equal(entries.filter(e => e.kind === "erasure").length, 1);
    assert.ok(!JSON.stringify(entries).includes(privateRetryInput));
    return entries;
  }
  return { project, build, store, mark, markPrivate, reconciled };
}

test("openSession retries pending erasure on the existing writer", async t => {
  const f = await retryFixture(t), agent = await f.build({ script: [{ text: "seed" }] });
  const open = await agent.session(), target = await f.markPrivate(open);
  assert.equal((await agent.openSession(open.id)).id, open.id);
  await f.reconciled(open.id, target);
  await open.setSetting("title", "existing writer remains usable");
});

test("an authorized direct command sees reconciled history", async t => {
  const f = await retryFixture(t);
  let target: string;
  const command = definePlugin({ name: "retry-command", setup(r) {
    r.command("check_history", "Check persisted history", async (_, cx) => {
      await f.reconciled(cx.sessionId, target);
      return "reconciled";
    });
  } });
  const agent = await f.build({ script: [{ text: "seed" }], plugins: [command] });
  const session = await agent.session();
  target = await f.markPrivate(session);
  assert.equal(await session.runCommand("/check_history"), "reconciled");
});

test("rewind retries pending erasure before committing position", async t => {
  const f = await retryFixture(t);
  const marker = join(f.project, "point.txt");
  await writeFile(marker, "saved");
  const agent = await f.build({ script: [{ text: "seed" }, { text: "seed" }], environment: {
    ...localEnvironment(f.project), points: true,
    save: () => readFile(marker, "utf8"),
    async hasPoint(point) { return point === "saved" || point === "current"; },
    async restore(point) { await writeFile(marker, point); },
  } });
  const session = await agent.session();
  await session.prompt("Save point");
  const point = (await f.store.load(session.id)).entries.find(e => e.kind === "turnEnd")!.id;
  const target = await f.markPrivate(session);
  await writeFile(marker, "current");
  await session.moveTo(point, { rewind: true });
  const entries = await f.reconciled(session.id, target);
  const rewind = entries.findIndex(e => e.kind === "position" && (e.data as { to?: string }).to === point);
  assert.ok(rewind > entries.findIndex(e => e.kind === "erasure"));
  assert.equal((await session.history({ all: false })).at(-1)?.id, point);
  assert.equal(await readFile(marker, "utf8"), "saved");
});

test("an approval decision retries and retires only the affected view", async t => {
  const f = await retryFixture(t);
  const agent = await f.build({ approval: "all", maxApprovalWaitMs: 60_000, questionsOutlastTurns: true,
    settings: { approvalWait: "untilDeadline" },
    tools: [tool({ name: "fixture", description: "Waiting approval fixture", input: { type: "object" }, run: () => "ran" })],
    script: [...["unaffected", "affected"].map(name => ({ toolCalls: [{ name: "fixture", input: { name } }] })), { text: "done" }],
  });
  const session = await agent.session();
  for (const name of ["unaffected", "affected"]) assert.equal((await session.prompt(`Park ${name}`)).openToolCalls?.length, 1);
  const questions = await session.questions({ present: true });
  const [affected, unaffected] = ["affected", "unaffected"].map(name => questions.find(q => q.call?.input.name === name)!);
  assert.ok(affected && unaffected);
  const { entries } = await f.store.load(session.id);
  const target = entries.find(e => e.kind === "inputRequest" && e.requestId === affected.id)!;
  await f.mark(session.id, [target.id]);
  await assert.rejects(session.answer(affected.id, "allow"), { code: "conflict" });
  const rows = await f.reconciled(session.id, target.id);
  const results = rows.filter(e => e.kind === "toolResult" && e.toolCallId === target.toolCallId);
  assert.equal(results.length, 1);
  assert.ok(results[0].erased || (results[0].data as { status: string }).status === "refused");
  assert.ok(!rows.some(e => e.kind === "toolStarted" && e.toolCallId === target.toolCallId));
  await assert.rejects(session.answer(affected.id, "allow"));
  // Do not re-poll: the independent view was delivered before erasure.
  await session.answer(unaffected.id, "allow");
  assert.ok(!(await session.questions()).some(q => q.id === affected.id));
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
  let a: Awaited<ReturnType<typeof createAgent>> | undefined;
  t.after(async () => {
    resume();
    try { await a?.close(); } finally {
      try { await service.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
  const request = async <T = unknown>(path: string, method: string, body?: object): Promise<T> => {
    const reply = await fetch(service.url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body && JSON.stringify(body) });
    assert.equal(reply.status, 200);
    return await reply.json() as T;
  };
  const source = "/v1/sessions/source", dest = "/v1/sessions/destination";
  for (const [path, id] of [[source, "source-target"], [dest, "dest-target"]]) {
    await request(path, "PUT", { created: Date.now(), project: dir });
    const { lease } = await request<{ lease: string }>(path + "/lease", "POST", { owner: "wire-writer" });
    await request(path + "/entries", "POST", { lease, entries: [{ id, parentId: null, kind: "fixture.note", data: { text: "private input" } }] });
    await request(`${path}/lease/${lease}`, "DELETE");
  }
  // This checks the history delivery fence, not a model turn. Seed before opening the writer.
  a = await createAgent({ durability: "kept", history: httpHistory(service.url, tokenFile), project: dir, environment: memoryEnvironment(),
    plugins: [definePlugin({ name: "pause-delivery", setup(registrar) {
      registrar.on("output", async () => { if (pause) { gated(); await release; } });
    } })],
  });
  const view = await a.openSession("destination");
  assert.ok((await view.history()).some(entry => entry.id === "dest-target"));
  const { lease } = await request<{ lease: string }>(source + "/lease", "POST", { owner: "wire-writer" });
  pause = true;
  const refused = assert.rejects(view.history(), { code: "unavailable" });
  await atGate;
  try {
    const { revision } = await request<{ revision: string }>(source + "/pending-erasure", "GET");
    await request(source + "/pending-erasure", "POST", { lease, revision, intentId: "mark", entryIds: ["source-target"],
      copies: [{ sessionId: "source", recordId: "source-book", entryIds: ["source-target"] },
        { sessionId: view.id, recordId: "dest-book", entryIds: ["dest-target"] }] });
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
  const wallClock = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(wallClock, 0, BigInt(Date.now()));
  t.mock.method(Date, "now", () => Number(Atomics.load(wallClock, 0)));
  const service = await historyService({ dir: join(dir, "store"), token, retention }, { wallClock });
  cleanup.push(() => new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve())));
  const config = { durability: "kept" as const, history: httpHistory(service.url, tokenFile), script: [{ text: "private answer" }] };
  const first = await testAgent(config);
  cleanup.push(() => first.close());
  const source = await first.session();
  await source.prompt("private input");
  const target = (await source.history()).find(e => e.kind === "input")!.id;
  const dest = await source.fork();
  await dest.close();
  Atomics.add(wallClock, 0, BigInt(retention / 2));
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

  Atomics.add(wallClock, 0, BigInt(retention / 2));
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

test("a new HTTP registry is not created over an unidentified store", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-http-nonempty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "obligations"), "unverified");
  await assert.rejects(historyService({ dir, token: "fixture" }), /empty directory/);
  assert.deepEqual(await readdir(dir), ["obligations"]);
});

test("a registry without publication order stays unavailable and unmodified", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-http-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { dir, token: randomBytes(32).toString("hex") };
  const first = await historyService(options);
  await new Promise<void>((resolve, reject) => first.server.close(error => error ? reject(error) : resolve()));
  const path = join(dir, "history.sqlite");
  const db = new DatabaseSync(path);
  try { db.exec("ALTER TABLE registry_intents DROP COLUMN session_ids"); } finally { db.close(); }
  await assert.rejects(historyService(options), /unavailable/i);
  const check = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(check.prepare("SELECT 1 FROM pragma_table_info('registry_intents') WHERE name='session_ids'").get(), undefined); }
  finally { check.close(); }
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

// The reader must ask SQLite for its lock while the writer still holds it. A test cannot see that
// request. So the reader takes a timestamp just before it calls intents(), the writer takes one just
// before COMMIT, and an attempt counts only if the reader's came at least MARGIN_MS earlier; it is
// retried otherwise. Without the busy timeout such an attempt throws unless the reader stalled for
// MARGIN_MS between its timestamp and its lock request. The lock-timeout test below holds the lock
// throughout and shows the wait on its own.
const HOLD_MS = 2_000;
const MARGIN_MS = 1_500;

async function readDuringWriteLock(expected: { id: string }) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-erasure-lock-wait-"));
  const state = new Int32Array(new SharedArrayBuffer(8));
  filePendingErasure(dir);
  const worker = new Worker(new URL("./fixtures/erasure-reader.js", import.meta.url), {
    workerData: { dir, state },
  });
  try {
    const replyPromise = once(worker, "message");
    assert.notEqual(await Atomics.waitAsync(state, 1, 0, 10_000).value, "timed-out", "reader worker did not become ready");
    const locker = new DatabaseSync(join(dir, "pending-erasure.sqlite"));
    let commitAt: number;
    try {
      locker.exec("BEGIN EXCLUSIVE");
      locker.prepare("INSERT INTO erasure VALUES (?, ?)").run(expected.id, JSON.stringify(expected));
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      await new Promise(resolve => setTimeout(resolve, HOLD_MS));
      commitAt = performance.timeOrigin + performance.now();
      locker.exec("COMMIT");
    } finally {
      try { if (locker.isTransaction) locker.exec("ROLLBACK"); } finally { locker.close(); }
    }
    const [reply] = await replyPromise as [{ ok: boolean; intents?: unknown; startedAt: number }];
    return { reply, lead: commitAt - reply.startedAt };
  } finally {
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
    await worker.terminate();
    await rm(dir, { recursive: true, force: true });
  }
}

test("filePendingErasure reader waits for a held write lock and returns committed intents", { timeout: 60_000 }, async () => {
  const expected = {
    id: "intent-1",
    sessionId: "session-1",
    actorId: "actor-1",
    targets: ["entry-1"],
    copies: [{ sessionId: "session-1", id: "entry-1", erased: false }],
  };
  const leads: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { reply, lead } = await readDuringWriteLock(expected);
    assert.deepEqual({ ...reply, startedAt: undefined }, { ok: true, intents: [expected], startedAt: undefined }, "intents() failed instead of waiting for the write lock");
    if (lead >= MARGIN_MS) return;
    leads.push(Math.round(lead));
  }
  assert.fail(`the reader never called intents() ${MARGIN_MS}ms before the commit; leads were ${leads.join(", ")}ms`);
});

test("filePendingErasure reader fails with unavailable when a write lock outlives the busy timeout", { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-erasure-lock-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = filePendingErasure(dir);
  const locker = new DatabaseSync(join(dir, "pending-erasure.sqlite"));
  locker.exec("BEGIN EXCLUSIVE");
  const started = performance.now();
  try {
    assert.throws(
      () => registry.intents(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, "unavailable");
        assert.equal((error.cause as { errcode?: number } | undefined)?.errcode, 5);
        return true;
      },
    );
  } finally {
    try { locker.exec("ROLLBACK"); } finally { locker.close(); }
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4_500, `expected reader to wait for busy_timeout before failing, failed after ${Math.round(elapsed)}ms`);
});
