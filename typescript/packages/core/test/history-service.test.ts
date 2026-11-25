/// <reference lib="es2024.sharedmemory" />
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";

import { HistoryArchive, historyService } from "@modular-agent/services";
import { fileHistory, serveHistory } from "../src/index.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-history-lease-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = "fixture-history-token";
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const store = fileHistory(join(dir, "store"));
  const options = { address: "127.0.0.1:0", tokenFile };
  return { store, options, token };
}

for (const { name, options: leaseOptions, ttlMs } of [
  { name: "the default lease", options: {}, ttlMs: 15_000 },
  { name: "the configured 1 ms lease", options: { leaseTtl: 1 }, ttlMs: 1 },
]) {
  test(`serveHistory declares ${name}`, async t => {
    const { store, options, token } = await fixture(t);
    const service = await serveHistory(store, { ...options, ...leaseOptions });
    try {
      const response = await fetch(`${service.url}/v1`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { ttlMs: number }).ttlMs, ttlMs);
    } finally {
      await service.close();
    }
  });
}

async function commitFixture(t: TestContext, leaseClock?: BigInt64Array<SharedArrayBuffer>) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-history-commit-"));
  const state = new Int32Array(new SharedArrayBuffer(4));
  const token = "fixture-history-token", ttlMs = 15_000;
  const worker = new Worker(new URL("./fixtures/history-renewal.js", import.meta.url), {
    workerData: { dir, token, ttlMs, controls: { commitGate: { sessionId: "writing", state }, leaseClock } },
  });
  t.after(async () => { await worker.terminate(); await rm(dir, { recursive: true, force: true }); });
  const [url] = await once(worker, "message");
  const request = (path: string, method: string, body?: object, signal?: AbortSignal) => fetch(`${url}/v1/sessions/${path}`, {
    method, signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const acquire = async (sid: string) => {
    assert.equal((await request(sid, "PUT", { project: "/p", created: 1 })).status, 200);
    const reply = await request(`${sid}/lease`, "POST", { owner: sid });
    assert.equal(reply.status, 200);
    return (await reply.json() as { lease: string }).lease;
  };
  return {
    request, acquire, ttlMs,
    async whileCommitting(lease: string, action: () => Promise<void>) {
      let finished = false;
      const write = request("writing/entries", "POST", { lease, entries: [{ id: "entry", parentId: null }] })
        .then(reply => { finished = true; return reply; });
      try {
        assert.notEqual(await Atomics.waitAsync(state, 0, 0, 10_000).value, "timed-out", "append did not reach the commit gate");
        await action();
        assert.equal(finished, false, "append must not finish before the gate opens");
      } finally {
        Atomics.store(state, 0, 2);
        Atomics.notify(state, 0);
        await write;
      }
      return write;
    },
    async renew(sid: string, lease: string) {
      const reply = await request(`${sid}/lease/${lease}/renew`, "POST", undefined, AbortSignal.timeout(2_500));
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), { ttlMs });
    },
  };
}

test("a current lease renews while another session's commit is blocked", { timeout: 30_000 }, async t => {
  const f = await commitFixture(t);
  const writer = await f.acquire("writer");
  const other = await f.acquire("writing");
  const write = await f.whileCommitting(other, () => f.renew("writer", writer));
  assert.equal(write.status, 200);
});

for (const renew of [false, true]) {
  test(renew ? "append checks the renewed deadline at commit" : "append rolls back when its lease expires before commit",
    { timeout: 30_000 }, async t => {
      const leaseClock = new BigInt64Array(new SharedArrayBuffer(8));
      const f = await commitFixture(t, leaseClock);
      const lease = await f.acquire("writing");
      const advanceMs = (ms: number) => Atomics.add(leaseClock, 0, BigInt(ms) * 1_000n);
      const write = await f.whileCommitting(lease, async () => {
        advanceMs(f.ttlMs - 1);
        if (renew) await f.renew("writing", lease);
        advanceMs(1);
      });
      assert.equal(write.status, renew ? 200 : 409);
      if (!renew) assert.equal((await write.json() as { code: string }).code, "lost");
      const reply = await f.request("writing", "GET");
      assert.equal(reply.status, 200);
      assert.deepEqual((await reply.json() as { entries: object[] }).entries, renew ? [{ id: "entry", parentId: null }] : []);
    });
}

test("a served archive still excludes direct and HTTP writers from the same session", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-history-shared-"));
  const archive = new HistoryArchive(dir);
  const store = archive.store(), token = "fixture-history-token";
  await store.create({ id: "session", project: "/p", created: 1 });
  await store.openForWriting("session");
  const { server, url } = await historyService({ archive, token });
  try {
    const acquire = () => fetch(`${url}/v1/sessions/session/lease`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ owner: "remote" }),
    });
    assert.equal((await acquire()).status, 409);
    await store.close("session");
    assert.equal((await acquire()).status, 200);
    assert.equal(store.writerActive?.("session"), true);
    await assert.rejects(store.openForWriting("session"), { code: "held" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("serveHistory refuses invalid lease durations", async t => {
  const { store, options } = await fixture(t);
  for (const leaseTtl of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(async () => {
      const service = await serveHistory(store, { ...options, leaseTtl });
      await service.close();
    }, { code: "invalid_params", message: /leaseTtl/ });
  }
});
