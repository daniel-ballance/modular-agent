import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

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

test("serveHistory refuses invalid lease durations", async t => {
  const { store, options } = await fixture(t);
  for (const leaseTtl of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(async () => {
      const service = await serveHistory(store, { ...options, leaseTtl });
      await service.close();
    }, { code: "invalid_params", message: /leaseTtl/ });
  }
});
