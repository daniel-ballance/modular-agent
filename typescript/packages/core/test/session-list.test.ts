import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAgent, type Provider } from "../src/index.js";

const provider: Provider = { id: "a", supports: { keepsState: false, safeToRepeat: true },
  models: () => [{ provider: "a", id: "test", contextWindow: 4000, maxOutput: 512, reasoning: false, input: ["text"] }],
  request: () => ({ role: "assistant", stop: "finished", content: [{ type: "text", text: "ok" }] }),
};

async function find(dir: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { const found = await find(path, name); if (found) return found; }
    else if (entry.name === name) return path;
  }
}

// docs/reference/standard-configuration.md, "Listing sessions": last activity is the
// last entry's time in append order, and a session with no entries has none.
test("sessions() gives a session with no entries no last activity", async t => {
  const project = await mkdtemp(join(tmpdir(), "ma-list-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const options = { project, dataDir: project, durability: "kept" as const, model: "a/test", providers: [provider] };
  const first = await createAgent(options);
  const session = await first.session();
  await session.prompt("First");
  await session.waitIdle();
  await first.close();

  // A file holding only its header, as a crash before the first whole batch leaves it.
  const file = await find(project, `${session.id}.jsonl`);
  assert.ok(file, "the session is kept in a file");
  const header = JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]);
  const empty = "emptysession";
  await writeFile(join(dirname(file), `${empty}.jsonl`), JSON.stringify({ ...header, meta: { ...header.meta, id: empty, created: Date.now() + 60_000 } }) + "\n");

  const second = await createAgent(options);
  t.after(() => second.close());
  const listed = new Map((await second.sessions()).map(s => [s.id, s.updated]));
  assert.equal(listed.get(empty), 0);
  assert.ok((listed.get(session.id) ?? 0) > 0);
});
