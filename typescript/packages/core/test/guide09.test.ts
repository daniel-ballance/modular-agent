import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAgent, fileHistory, httpHistory, serveHistory } from "../src/index.js";
import { scriptedProvider } from "../src/testing.js";

function serveStore(address: string, storeDir: string, tokenFile: string) {
  return serveHistory(fileHistory(storeDir), { address, tokenFile });
}

function connectHistory(project: string, dataDir: string, url: string, tokenFile: string) {
  return createAgent({
    project, dataDir, durability: "kept",
    history: httpHistory(url, tokenFile),
    providers: [scriptedProvider([{ text: "Whitby." }, { text: "14:02." }])],
    model: "scripted/script",
  });
}

async function handoff(project: string, writerDir: string, readerDir: string, url: string, tokenFile: string) {
  const writer = await connectHistory(project, writerDir, url, tokenFile);
  let id: string;
  try {
    const first = await writer.session();
    assert.equal((await first.prompt("Name a harbour.")).text, "Whitby.");
    id = first.id;
  } finally {
    await writer.close(); // Give up the writer lease.
  }

  const reader = await connectHistory(project, readerDir, url, tokenFile);
  try {
    const reopened = await reader.openSession(id);
    assert.equal((await reopened.lastTurn())?.text, "Whitby.");
    assert.equal((await reopened.prompt("When is high tide there?")).text, "14:02.");
    const history = await reopened.history();
    assert.deepEqual(history.filter(e => e.kind === "input").map(e => e.actorId), ["user", "user"]);
  } finally {
    await reader.close();
  }
}

// Hang guard only: the test waits for prompts and close, not for lease expiry.
// A loaded run took 62 seconds with service setup and durable writes.
test("hands off a session over HTTP", { timeout: 90_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), "guide09-"));
  const project = join(tmp, "project");
  const tokenFile = join(tmp, "token");
  try {
    await mkdir(project);
    await writeFile(tokenFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    const service = await serveStore("127.0.0.1:0", join(tmp, "history"), tokenFile);
    try {
      const url = new URL(service.url);
      assert.equal(url.hostname, "127.0.0.1");
      assert.ok(Number(url.port) > 0, "serveHistory returns the selected port");
      await handoff(project, join(tmp, "writer"), join(tmp, "reader"), service.url, tokenFile);
    } finally {
      await service.close();
    }
    const url = new URL(service.url);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      socket.once("error", reject);
      socket.once("connect", () => { socket.destroy(); resolve(); });
    }), { code: "ECONNREFUSED" });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
