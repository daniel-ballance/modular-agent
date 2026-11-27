import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentError, fileHistory, tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { Harness } from "@modular-agent/harness";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";

const text = [{ type: "text" as const, text: "proposal" }];
const tenant = { rights: ["watch", "propose", "input"] as ("watch" | "propose" | "input")[] };

test("the last input slot can be charged once across simultaneous sessions", async t => {
  const agent = await testAgent({ script: [], severalActors: true, tenants: { A: tenant, B: tenant },
    resourceReservations: { session: { inputs: 1 }, tenant: { inputs: 1 }, agent: { inputs: 2 } } });
  t.after(() => agent.close());
  const a = await agent.session({ tenant: "A" }), b = await agent.session({ tenant: "A" });
  const c = await agent.session({ tenant: "B" }), d = await agent.session();
  const admissions = await Promise.allSettled([a.send(text, "propose", { key: "one" }), b.send(text, "propose", { key: "one" })]);
  const winner = admissions.findIndex(result => result.status === "fulfilled");
  assert.equal(admissions.filter(result => result.status === "fulfilled").length, 1);
  const loser = admissions[1 - winner];
  assert.equal(loser.status, "rejected");
  assert.equal(loser.reason.code, "busy");
  const owner = [a, b][winner];
  const [{ inputId }] = await owner.proposals();
  assert.equal((await owner.send(text, "propose", { key: "one" })).duplicate, true);
  await assert.rejects(owner.send(text, "propose", { key: "two" }), { code: "busy" });
  await c.send(text, "propose");
  await assert.rejects(d.send(text, "propose"), { code: "busy" });
  await owner.withdraw(inputId);
  assert.equal((await [a, b][1 - winner].send(text, "propose", { key: "one" })).duplicate, undefined);
});

test("an oversized call list records one failed response, preserves usage and dispatches nothing", async t => {
  let dispatched = 0;
  const count = tool({ name: "count", description: "Count invocations", input: { type: "object" }, run() { dispatched++; } });
  const agent = await testAgent({ tools: [count], resourceReservations: { session: { calls: 1 } },
    script: [{ toolCalls: [{ name: "count", input: {} }, { name: "count", input: {} }], usage: { input: 8, output: 2 } }] });
  t.after(() => agent.close());
  const session = await agent.session();
  const result = await session.prompt("Start");
  assert.deepEqual(result.outcome, { kind: "limit", limit: "capacity" });
  assert.equal(dispatched, 0);
  const responses = (await session.history()).filter(e => e.kind === "response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].message?.role, "assistant");
  assert.equal(responses[0].message.stop, "failed");
  assert.deepEqual(responses[0].message.content, []);
  assert.equal(responses[0].message.usage?.input, 8);
});

test("a reopened agent charges persisted proposals before admitting to another session", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-reservations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = fileHistory(join(dir, "record"));
  const options = { project: dir, dataDir: dir, history, durability: "kept" as const, severalActors: true, script: [] };
  const first = await testAgent(options);
  const session = await first.session();
  const proposal = await session.send(text, "propose");
  await first.close();
  const second = await testAgent({ ...options, resourceReservations: { agent: { inputs: 1 } } });
  t.after(() => second.close());
  const next = await second.session();
  await assert.rejects(next.send(text, "propose"), { code: "busy" });
  const previous = await second.openSession(session.id);
  await previous.withdraw(proposal.inputId);
  assert.ok((await next.send(text, "propose")).inputId);
});

test("reconstructed payload bytes block new work but not hand-back", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-reserved-bytes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { project: dir, dataDir: dir, durability: "kept" as const, severalActors: true, script: [] };
  const first = await testAgent(config);
  const saved = await first.session();
  const proposed = await saved.send("é".repeat(650), "propose", { key: "saved" });
  await first.close();
  const resumed = await testAgent({ ...config, resourceReservations: { agent: { bufferedBytes: 1500 } } });
  t.after(() => resumed.close());
  const next = await resumed.session();
  await assert.rejects(next.send("x".repeat(500), "propose", { key: "refused" }), { code: "busy" });
  const old = await resumed.openSession(saved.id);
  assert.equal((await old.send("Ignored", "propose", { key: "saved" })).duplicate, true);
  await old.withdraw(proposed.inputId);
  const accepted = await next.send("x".repeat(500), "propose", { key: "refused" });
  assert.ok(accepted.inputId);
  assert.equal(accepted.duplicate, undefined);
});

test("legacy admissions block their own open and still use agent and tenant storage", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-legacy-reservations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonlHistoryStore(join(dir, "history"));
  const team = { rights: [...tenant.rights, "settings" as const] };
  const options = { project: dir, dataDir: dir, durability: "kept" as const, tenants: { A: team, B: team },
    script: [{ text: "healthy" }, { text: "healthy" }] };
  const seed = await testAgent(options);
  const a = await seed.session({ tenant: "A" }), b = await seed.session({ tenant: "B" });
  await a.prompt("healthy A");
  await b.prompt("healthy B");
  await seed.close();

  const meta = { id: "legacy", project: dir, created: 0 };
  await store.create(meta);
  await store.openForWriting(meta.id);
  await store.append(meta.id, [
    { id: "legacy-tenant", sessionId: meta.id, time: 0, parentId: null, writer: "harness",
      kind: "tenant", modelVisible: false, data: { tenant: "A" } },
    { id: "legacy-admission", sessionId: meta.id, time: 0, parentId: "legacy-tenant", writer: "harness",
      kind: "inputAccepted", modelVisible: false, actorId: "local", inputId: "legacy-input",
      data: { content: [{ type: "text", text: "é".repeat(4096) }], when: "propose", taken: "proposed" } },
  ]);
  await store.close(meta.id);
  const storedBytes = async (id: string) => {
    const { meta, entries } = await store.load(id);
    return [meta, ...entries].reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0);
  };
  const legacy = await storedBytes(meta.id), healthyA = await storedBytes(a.id), healthyB = await storedBytes(b.id);

  for (const scope of ["agent", "tenant"] as const) {
    const storageBytes = legacy + healthyA + (scope === "agent" ? healthyB : 0);
    const agent = await testAgent({ ...options, resourceReservations: { [scope]: { storageBytes, controlBytes: 0, inputs: 1 } } });
    try {
      if (scope === "tenant") assert.ok((await agent.session()).id);
      const opened = await agent.openSession(a.id);
      assert.equal(opened.id, a.id);
      await assert.rejects(agent.openSession(meta.id), { message: "Malformed inputAccepted history record: legacy-admission" });
      await assert.rejects(opened.setSetting("title", "blocked"), { code: "busy" });
      const other = await agent.openSession(b.id);
      if (scope === "tenant") await other.setSetting("title", "allowed");
      else await assert.rejects(other.setSetting("title", "blocked"), { code: "busy" });
    } finally {
      await agent.close();
    }
  }
});

for (const operation of ["list", "load"] as const) test(`reservation rebuild propagates store ${operation} failures`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-unavailable-reservations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonlHistoryStore(join(dir, "history"));
  const meta = { id: "unavailable", project: dir, created: 0 };
  if (operation === "load") t.mock.method(store, "list", async () => [meta]);
  const error = new AgentError("unavailable", "Cannot verify history restore freshness");
  const failed = t.mock.method(store, operation, async () => { throw error; });
  const harness = new Harness({ project: dir, home: dir });
  await harness.load([{ name: "test.history", setup: api => api.provide("history-store", store) }]);
  await assert.rejects(harness.rebuildReservations(), actual => actual === error);
  assert.equal(failed.mock.callCount(), 1);
});
