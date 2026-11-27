import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileHistory, httpHistory, serveHistory } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";

const cases = JSON.parse(await readFile(new URL("../../../../../conformance/history/restore-freshness.json", import.meta.url), "utf8")) as { change: string; recordKind: string }[];
const token = "fixture-0123456789-0123456789-0123456789";

for (const http of [false, true]) for (const { change, recordKind } of cases) {
  test(`${http ? "HTTP" : "file"} witness rejects rollback after ${change}, admits latest restore`, async t => {
    const root = await mkdtemp(join(tmpdir(), "restore-freshness-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "history"), restoreWitness = join(root, "witness"), tokenFile = join(root, "token");
    await writeFile(tokenFile, token, { mode: 0o600 });
    const options = { address: "127.0.0.1:0", tokenFile, leaseTtl: 500 };
    const serve = () => serveHistory(fileHistory(dir, { restoreWitness }), options);
    const service = http ? await serve() : undefined;
    const build = (listener = service) => testAgent({ project: root, severalActors: true, durability: "kept",
      script: [{ text: "private response" }], history: listener ? httpHistory(listener.url, tokenFile) : fileHistory(dir, { restoreWitness }) });
    const agent = await build();
    let id: string;
    try {
      const session = await agent.session();
      id = session.id;
      await session.join({ id: "guest", kind: "user", rights: ["watch"] });
      await session.prompt("private input");
      const input = (await session.history()).find(e => e.kind === "input")!;
      await session.close();
      await cp(dir, join(root, "old"), { recursive: true });
      const writer = await agent.openSession(id);
      if (change === "erasure") assert.ok((await writer.erase([input.id])).erased.some(e => e.id === input.id));
      else await writer.leave("guest");
      await writer.close();
    } finally { await agent.close(); await service?.close(); }
    await rename(dir, join(root, "current"));
    await rename(join(root, "old"), dir);
    if (http) await assert.rejects(serve, { code: "unavailable" });
    else await assert.rejects(build, { code: "unavailable" });
    await rm(dir, { recursive: true });
    await rename(join(root, "current"), dir);
    const freshService = http ? await serve() : undefined;
    const restored = await build(freshService);
    try {
      if (http) await delay(options.leaseTtl); // The service excludes writers across restart for one TTL.
      const view = await restored.openSession(id);
      assert.ok((await view.history()).some(e => e.kind === recordKind));
    } finally { await restored.close(); await freshService?.close(); }
  });
}

test("non-empty file history does not recreate a missing registry", async t => {
  const root = await mkdtemp(join(tmpdir(), "restore-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "history"), registry = join(dir, "pending-erasure.sqlite");
  const build = () => testAgent({ project: root, durability: "kept", script: [{ text: "stored" }], history: fileHistory(dir) });
  const agent = await build();
  const session = await agent.session();
  await session.prompt("persist");
  await agent.close();
  await rm(registry);
  await assert.rejects(build, { code: "unavailable" });
  await assert.rejects(stat(registry), { code: "ENOENT" });
});
