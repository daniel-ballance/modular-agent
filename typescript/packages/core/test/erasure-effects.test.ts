import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, definePlugin, defineProvider, fileHistory, httpHistory, serveHistory, tool } from "@modular-agent/core";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { HttpHistoryStore } from "@modular-agent/services";
import { overWire, testAgent } from "@modular-agent/core/testing";

for (const http of [false, true]) test(`copy discovery does not replay malformed intake (${http ? "HTTP" : "file"})`, async t => {
  const project = await mkdtemp(join(tmpdir(), "sdk-erasure-intake-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const root = join(project, "history");
  const local = new JsonlHistoryStore(root);
  const tokenFile = join(project, "token");
  const token = "test-token-for-erasure";
  await writeFile(tokenFile, token, { mode: 0o600 });
  const server = http ? await serveHistory(fileHistory(root), { address: "127.0.0.1:0", tokenFile }) : undefined;
  const history = server ? httpHistory(server.url, tokenFile) : undefined;
  t.after(() => server?.close());
  const agent = await testAgent({ project, dataDir: project, history, durability: "kept", script: [{ text: "first" }, { text: "second" }] });
  try {
    const source = await agent.session();
    await source.prompt("first");
    await source.prompt("second");
    const replies = (await source.history()).filter(e => e.kind === "response");
    const malformed = "legacy";
    const meta = { project, created: 1, forkedFrom: { sessionId: source.id, entryId: replies[1].id } };
    const entries = [
      { id: "legacy-copy", sessionId: malformed, time: 1, parentId: null, writer: "test", kind: "summary", modelVisible: true,
        sources: [replies[1].id], data: { text: "retained copy" } },
      { id: "legacy-admission", sessionId: malformed, time: 2, parentId: "legacy-copy", writer: "harness", kind: "inputAccepted",
        modelVisible: false, inputId: "legacy-input", actorId: "user", data: { content: [], taken: "after", when: "after" } },
    ];
    if (server) {
      const raw = async (suffix: string, method: string, body: object) => {
        const response = await fetch(`${server.url}/v1/sessions/${malformed}${suffix}`, { method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        return await response.json() as { lease: string };
      };
      await raw("", "PUT", meta);
      const { lease } = await raw("/lease", "POST", { owner: "fixture" });
      await raw("/entries", "POST", { lease, entries });
      const release = await fetch(`${server.url}/v1/sessions/${malformed}/lease/${lease}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      assert.equal(release.status, 200);
    } else {
      await local.create({ ...meta, id: malformed });
      await local.openForWriting(malformed);
      await local.append(malformed, entries);
      await local.close(malformed);
    }
    await assert.rejects(agent.openSession(malformed), { message: "Malformed inputAccepted history record: legacy-admission" });
    const report = await source.erase([replies[1].id]);
    assert.ok(report.erased.some(copy => copy.id === replies[1].id));
    assert.ok(report.outOfReach.includes("copies in other sessions"));
    const client = server && new HttpHistoryStore({ url: server.url, token });
    if (client) await client.list();
    const remote = client && client.historyErasure;
    if (remote) assert.ok((await remote.read(malformed)).plans.some(plan => plan.copies.some(copy => copy.entryId === "legacy-copy" && !copy.complete)));
    else assert.ok(local.pendingErasure?.intents().some(intent => intent.copies.some(copy => copy.id === "legacy-copy" && !copy.erased)));
  } finally { await agent.close(); }
});

for (const pending of [false, true]) for (const confirm of [false, true]) {
  test(`erasure ${pending ? "reconciles a destination" : "on the source"} with ${confirm ? "confirmed" : "unconfirmed"} job cleanup`, async t => {
    const project = await mkdtemp(join(tmpdir(), "sdk-erasure-job-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    let cancels = 0;
    const plugin = definePlugin({ name: "erasure-jobs", setup(r) {
      r.jobs({ async cancel(_job, cx) {
        cancels++;
        if (!confirm) throw new Error("could not stop");
        await cx.job.end({ kind: "cancelled" }, "must not enter history", true);
      } });
      r.tool(tool({ name: "lookup", description: "Start a job", input: { type: "object" }, async run(_, cx) {
        return (await cx.jobs.start("lookup", {})).id;
      } }));
    } });
    const options = { project, dataDir: project, durability: "kept" as const, plugins: [plugin], script: [{ text: "seed" }] };
    const a = await testAgent(options);
    const b = pending ? await testAgent(options) : a;
    try {
      const source = await a.session();
      await source.prompt("erase this");
      const id = (await source.history()).find(e => e.kind === "input")!.id;
      let destination = source;
      if (pending) {
        const fork = await source.fork();
        await fork.close();
        destination = await b.openSession(fork.id);
      }
      await destination.callTool("lookup", {});
      const report = await source.erase([id]);
      if (pending) assert.ok(report.pending.some(copy => copy.sessionId === destination.id));
      if (pending) {
        await assert.rejects(destination.history(), { code: "unavailable" });
        assert.equal((await b.reconcileErasure({ sessions: [destination.id] }))[0].state, "busy");
        assert.equal(cancels, 0);
      } else if (confirm) {
        const history = await destination.history();
        assert.ok(history.some(e => e.kind === "jobEnded"));
        assert.doesNotMatch(JSON.stringify(history), /must not enter history|erase this/);
      } else {
        await assert.rejects(destination.history(), { code: "unavailable" });
        assert.ok((await new JsonlHistoryStore(join(project, "history")).load(destination.id)).entries.some(e => e.kind === "jobCleanupUnconfirmed"));
      }
      if (!pending) assert.equal(cancels, confirm ? 1 : 2);
    } finally { await Promise.allSettled([a.close(), ...(pending ? [b.close()] : [])]); }
  });
}

for (const [retryByErase, served] of [[false, false], [true, false], [false, true]]) test(`pending job cleanup retries after restart (${retryByErase ? "erase" : "open"}, ${served ? "wire" : "local"})`, async t => {
  const project = await mkdtemp(join(tmpdir(), "sdk-erasure-job-retry-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  let cancels = 0, resumes = 0;
  const build = async (confirm: boolean) => {
    const plugin = definePlugin({ name: "erasure-jobs", setup(r) {
      r.jobs({ async cancel(job, cx) {
        cancels++;
        assert.equal(job.detail, null);
        assert.equal(cx.job.started, false);
        await cx.job.end({ kind: "cancelled" }, "must not enter history", true);
        if (!confirm) throw new Error("could not stop");
      }, resume() { resumes++; } });
      r.tool(tool({ name: "lookup", description: "Start a job", input: { type: "object" }, async run(_, cx) {
        return (await cx.jobs.start("lookup", { secret: "job detail" })).id;
      } }));
    } });
    const agent = await testAgent({ project, dataDir: project, durability: "kept", plugins: [served ? overWire(plugin) : plugin], script: [{ text: "seed" }] });
    t.after(() => agent.close());
    return agent;
  };
  const a = await build(false), b = await build(false);
  const source = await a.session();
  await source.prompt("erase this");
  const target = (await source.history()).find(e => e.kind === "input")!.id;
  const fork = await source.fork();
  await fork.close();
  const destination = await b.openSession(fork.id);
  await destination.callTool("lookup", {});
  assert.ok((await source.erase([target])).pending.some(copy => copy.sessionId === fork.id));
  await assert.rejects(destination.history(), { code: "unavailable" });
  assert.equal(cancels, 1);
  await b.close();
  await a.close();

  const c = await build(false);
  await assert.rejects(c.openSession(fork.id), { code: "unavailable" });
  assert.equal(cancels, 2);
  await c.close();

  const d = await build(true);
  const reopenedSource = await d.openSession(source.id);
  if (retryByErase) assert.deepEqual((await reopenedSource.erase([target])).pending, []);
  const reopened = await d.openSession(fork.id);
  const entries = await reopened.history();
  assert.equal(cancels, 3);
  assert.equal(resumes, 0);
  assert.equal(entries.filter(e => e.kind === "jobCleanupUnconfirmed").length, 1);
  assert.deepEqual(entries.filter(e => e.kind === "jobEnded").map(e => e.data), [{ outcome: { kind: "cancelled" }, report: false }]);
  assert.doesNotMatch(JSON.stringify(entries), /must not enter history|erase this/);
  assert.deepEqual((await reopenedSource.erase([target])).pending, []);
});

for (const pending of [false, true]) test(`erasure joins a live destination turn (${pending ? "reconciliation" : "direct"})`, { timeout: 5000 }, async t => {
  const project = await mkdtemp(join(tmpdir(), "sdk-erasure-live-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const barrier = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(ready => { resolve = ready; });
    return { promise, resolve };
  };
  const started = barrier(), cancelled = barrier(), release = barrier();
  let block: string | undefined;
  const provider = defineProvider({ id: "barrier", supports: { keepsState: false, safeToRepeat: true },
    models: () => [{ provider: "barrier", id: "model", contextWindow: 4096, maxOutput: 256, input: ["text"], reasoning: false }],
    async request(_model, _request, cx) {
      if (block && cx.sessionId === block) {
        cx.cancelled.addEventListener("abort", () => cancelled.resolve(), { once: true });
        started.resolve();
        await release.promise;
        return { role: "assistant", stop: "finished", content: [{ type: "text", text: "must not escape" }] };
      }
      return { role: "assistant", stop: "finished", content: [{ type: "text", text: "seed" }] };
    },
  });
  const options = { project, dataDir: project, durability: "kept" as const, providers: [provider] };
  const a = await createAgent(options);
  const b = pending ? await createAgent(options) : a;
  try {
    const source = await a.session();
    await source.prompt("erase this");
    const target = (await source.history()).find(e => e.kind === "input")!.id;
    let destination = await source.fork();
    if (pending) { await destination.close(); destination = await b.openSession(destination.id); }
    block = destination.id;
    const prompt = destination.prompt("running").then(result => result.text, () => undefined);
    await started.promise;
    if (pending) {
      assert.ok((await source.erase([target])).pending.some(copy => copy.sessionId === block));
      let aborted = false;
      void cancelled.promise.then(() => { aborted = true; });
      await assert.rejects(destination.setSetting("title", "not applied"), { code: "unavailable" });
      assert.equal((await b.reconcileErasure({ sessions: [destination.id] }))[0].state, "busy");
      assert.equal(aborted, false);
      release.resolve();
      assert.notEqual(await prompt, "must not escape");
      return;
    }
    let done = false;
    const erasing = source.erase([target]).finally(() => { done = true; });
    await cancelled.promise;
    assert.equal(done, false);
    release.resolve();
    await erasing;
    assert.notEqual(await prompt, "must not escape");
    assert.doesNotMatch(JSON.stringify(await destination.history()), /erase this|must not escape/);
  } finally { release.resolve(); await a.close(); if (pending) await b.close(); }
});

for (const pending of [false, true]) test(`a local Provider discards cached context on ${pending ? "reconciliation" : "erasure"} and cannot use it after reopen`, async t => {
  const project = await mkdtemp(join(tmpdir(), "sdk-erasure-provider-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const cached = new Set<string>();
  let attempts = 0;
  let discards = 0;
  const provider = defineProvider({ id: "local-cache", supports: { keepsState: true, safeToRepeat: false },
    models: () => [{ provider: "local-cache", id: "demo", contextWindow: 4096, maxOutput: 256, input: ["text"], reasoning: false }],
    request(_model, _request, cx) {
      const stale = cached.has(cx.sessionId!);
      cached.add(cx.sessionId!);
      attempts++;
      return { role: "assistant", stop: "finished", content: [{ type: "text", text: stale ? "stale" : "fresh" }] };
    },
    discardState(id) { discards++; cached.delete(id); },
  });
  const options = { project, dataDir: project, durability: "kept" as const, providers: [provider] };
  const a = await createAgent(options);
  const s = await a.session();
  try {
    assert.equal((await s.prompt("erase this")).text, "fresh");
    const origin = (await s.history()).find(e => e.kind === "input")!;
    if (pending) {
      const registry = new JsonlHistoryStore(join(project, "history")).pendingErasure;
      await registry.exclusive(async () => registry.keep({ id: "provider-erasure", sessionId: s.id, targets: [origin.id],
        actorId: "user", copies: [{ sessionId: s.id, id: origin.id, erased: false }],
        providers: [{ sessionId: s.id, provider: "local-cache", confirmed: false }] }));
      await s.history();
    } else assert.ok((await s.erase([origin.id])).erased.length);
    assert.equal(discards, 1);
  } finally { await a.close(); }
  const b = await createAgent(options);
  try {
    assert.equal((await (await b.openSession(s.id)).prompt("again")).text, "fresh");
    assert.equal(attempts, 2);
  } finally { await b.close(); }
});
