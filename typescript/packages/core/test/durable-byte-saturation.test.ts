import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileHistory, httpHistory, serveHistory } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { HttpHistoryStore } from "@modular-agent/services";

const fixture: { input: string; response: string; ordinaryWriteBytes: number; controlHeadroomBytes: number } =
  JSON.parse(await readFile(new URL("../../../../../conformance/history/durable-byte-saturation.json", import.meta.url), "utf8"));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

for (const backend of ["native", "HTTP"]) test(`${backend} history keeps the byte boundary`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-byte-saturation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storeDir = join(dir, "history"), tokenFile = join(dir, "token");
  const token = "fixture-0123456789-0123456789-0123456789";
  await writeFile(tokenFile, token, { mode: 0o600 });
  const service = backend === "HTTP" ? await serveHistory(fileHistory(storeDir), { address: "127.0.0.1:0", tokenFile }) : undefined;
  t.after(() => service?.close());
  const inspector = service ? new HttpHistoryStore({ url: service.url, token }) : new JsonlHistoryStore(storeDir);
  const options = { project: dir, dataDir: dir, durability: "kept" as const, script: [{ text: fixture.response }] };
  const build = async (bounds?: { storageBytes: number; controlBytes: number }) => {
    const agent = await testAgent({ ...options, history: service ? httpHistory(service.url, tokenFile) : undefined,
      resourceReservations: bounds && { session: bounds, tenant: bounds, agent: bounds } });
    t.after(() => agent.close());
    return agent;
  };
  const seed = await build();
  const source = await seed.session();
  await source.prompt(fixture.input);
  await seed.close();

  const snapshot = () => inspector.load(source.id);
  const before = await snapshot();
  const target = before.entries.find(e => e.kind === "input")!.id;
  const retained = bytes(before.meta) + before.entries.reduce((n, entry) => n + bytes(entry), 0);
  const tight = await build({ storageBytes: retained, controlBytes: 0 });
  const writer = await tight.openSession(source.id);
  await assert.rejects(writer.setSetting("title", "x".repeat(fixture.ordinaryWriteBytes)), { code: "busy" });
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(writer.fork(), { code: "busy" });
  assert.deepEqual((await inspector.list()).map(meta => meta.id), [source.id]);
  assert.deepEqual(await snapshot(), before);

  const report = await writer.erase([target]);
  assert.deepEqual(report.erased, []);
  assert.ok(report.pending.some(copy => copy.id === target));
  assert.deepEqual(await snapshot(), before, "no bookkeeping or tombstone on refusal");
  await assert.rejects(writer.history(), { code: "busy" });
  await tight.close();

  const headroom = fixture.controlHeadroomBytes;
  const resumed = await build({ storageBytes: retained + headroom, controlBytes: headroom });
  const opened = await resumed.openSession(source.id);
  const { entries } = await snapshot();
  assert.equal(entries.filter(e => e.kind === "erasure").length, 1);
  assert.ok(entries.some(e => e.id === target && e.erased));
  assert.deepEqual((await opened.erase([target])).pending, []);
  assert.equal((await snapshot()).entries.filter(e => e.kind === "erasure").length, 1);
  await resumed.close();
});
