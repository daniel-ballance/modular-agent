import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { startReceiver } from "./receiver.mjs";
import { readWire, wireTap } from "./wire.mjs";

test("receiver waits for an export and keeps duplicate observations", async t => {
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const span = { name: "hello" };
  const body = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span, span] }] }] });
  const waiting = receiver.waitFor(spans => spans.length === 2);
  const response = await fetch(receiver.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.deepEqual((await waiting).spans, [span, span]);
});

test("wire tap saves complete frames in both directions without changing bytes", async t => {
  const dir = await mkdtemp(join(tmpdir(), "telemetry-wire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "wire.ndjson");
  const lines = [' {"jsonrpc":"2.0","id":1,"method":"plugin/initialize"}\r', '{"jsonrpc":"2.0","id":1,"result":{}}'];
  for (const [direction, raw] of [["hostToPlugin", lines[0]], ["pluginToHost", lines[1]]]) {
    const forwarded = [];
    await pipeline(Readable.from([Buffer.from(raw.slice(0, 4)), Buffer.from(raw.slice(4) + "\n")]),
      wireTap(file, direction), new Writable({ write(chunk, _, callback) { forwarded.push(chunk); callback(); } }));
    assert.equal(Buffer.concat(forwarded).toString(), raw + "\n");
  }
  assert.deepEqual(readWire(file).map(({ direction, raw }) => [direction, raw]), [
    ["hostToPlugin", lines[0]], ["pluginToHost", lines[1]],
  ]);
});
