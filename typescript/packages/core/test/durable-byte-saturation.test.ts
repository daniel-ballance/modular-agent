import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileHistory, httpHistory, localEnvironment, serveHistory } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { HttpHistoryStore } from "@modular-agent/services";

const fixture: { input: string; response: string; ordinaryWriteBytes: number; controlHeadroomBytes: number } =
  JSON.parse(await readFile(new URL("../../../../../conformance/history/durable-byte-saturation.json", import.meta.url), "utf8"));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const retainedBytes = ({ meta, entries }: Awaited<ReturnType<JsonlHistoryStore["load"]>>) =>
  bytes(meta) + entries.reduce((n, entry) => n + bytes(entry), 0);

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
  const retained = retainedBytes(before);
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

for (const mode of ["complete", "compensate", "recover"]) test(`rewind can ${mode} under ordinary byte saturation`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-rewind-saturation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "source"), other = join(dir, "filler"), storeDir = join(dir, "history");
  await mkdir(project);
  await mkdir(other);
  const file = join(project, "file.txt");
  await writeFile(file, "target");
  const entered = gate(), resume = gate();
  let pauseTarget = false, failUndo = mode === "recover";
  const environment = {
    ...localEnvironment(project), points: true,
    save: () => readFile(file, "utf8"),
    async hasPoint(point: string) { return point === "target" || point === "current"; },
    async restore(point: string) {
      if (point === "target") {
        if (pauseTarget) {
          entered.resolve();
          await resume.promise;
        }
        if (mode !== "complete") {
          await writeFile(file, "partial");
          throw new Error("target restore failed");
        }
      } else if (failUndo) throw new Error("undo restore unavailable");
      await writeFile(file, point);
    },
  };
  const build = async (path: string, ordinary?: number) => {
    const controlBytes = fixture.controlHeadroomBytes;
    const shared = { storageBytes: (ordinary ?? 0) + controlBytes, controlBytes };
    const agent = await testAgent({ project: path, dataDir: dir, durability: "kept", environment,
      script: [{ text: fixture.response }, { text: fixture.response }],
      resourceReservations: ordinary === undefined ? undefined : { session: { ...shared, storageBytes: 1_000_000 }, tenant: shared, agent: shared } });
    t.after(() => agent.close());
    return agent;
  };
  const seed = await build(project);
  const source = await seed.session();
  await source.prompt("before the rewind target");
  await source.prompt(fixture.input);
  await seed.close();
  const seedOther = await build(other);
  const otherSource = await seedOther.session();
  await otherSource.prompt("seed filler");
  await otherSource.setSetting("title", "");
  await seedOther.close();
  await writeFile(file, "current");

  const store = new JsonlHistoryStore(storeDir);
  const snapshot = () => store.load(source.id);
  const before = await snapshot();
  const target = before.entries.find(e => e.kind === "turnEnd")!.id;
  const erased = before.entries.findLast(e => e.kind === "input")!.id;
  const fillerBefore = await store.load(otherSource.id);
  const fillerOverhead = bytes(fillerBefore.entries.at(-1));
  const summed = async () => retainedBytes(await snapshot()) + retainedBytes(await store.load(otherSource.id));
  const stored = await summed();
  const tight = await build(project, stored);
  const tightWriter = await tight.openSession(source.id);
  await tight.openSession(otherSource.id);
  await assert.rejects(tightWriter.moveTo(target), { code: "busy" });
  await assert.rejects(tightWriter.moveTo(target, { rewind: true }), { code: "busy" });
  assert.equal(await readFile(file, "utf8"), "current");
  assert.deepEqual(await snapshot(), before);
  await tight.close();

  const ordinary = stored + fixture.ordinaryWriteBytes;
  const agent = await build(project, ordinary);
  const writer = await agent.openSession(source.id);
  const filler = await agent.openSession(otherSource.id);
  pauseTarget = true;
  const rewind = writer.moveTo(target, { rewind: true });
  // Attach the rejection handler before pausing, and always release the restore.
  const result = mode === "complete" ? rewind : assert.rejects(rewind, mode === "compensate" ? { code: "conflict" } : /undo restore unavailable/);
  void result.catch(() => {});
  try {
    await Promise.race([entered.promise, rewind.then(() => assert.fail("rewind did not reach restore"))]);
    const intent = (await snapshot()).entries.at(-1)!;
    assert.equal(intent.kind, "position");
    assert.deepEqual(intent.data, { to: target, restore: { point: "target", undo: "current" } });
    const remaining = ordinary - await summed();
    await filler.setSetting("title", "x".repeat(remaining - fillerOverhead));
    assert.equal(await summed(), ordinary, "filler consumes exactly the remaining ordinary bytes");
    await assert.rejects(filler.setSetting("title", "refused"), { code: "busy" });
  } finally { resume.resolve(); }
  await result;
  if (mode === "recover") {
    assert.deepEqual((await snapshot()).entries.at(-1)!.data, {
      to: before.entries.at(-1)!.id, restore: { point: "current", undo: "target" },
    });
    failUndo = false;
  }
  await writer.close();
  const reopened = await agent.openSession(source.id);
  const positions = (await snapshot()).entries.slice(before.entries.length);
  assert.equal(positions.length, mode === "complete" ? 2 : 3);
  assert.deepEqual(positions.at(-1)!.data, { to: mode === "complete" ? target : before.entries.at(-1)!.id });
  assert.equal(await readFile(file, "utf8"), mode === "complete" ? "target" : "current");
  assert.ok((await reopened.erase([erased])).erased.some(copy => copy.id === erased));
  await agent.close();
});
