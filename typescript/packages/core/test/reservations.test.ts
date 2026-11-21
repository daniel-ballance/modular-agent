import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileHistory, tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";

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
