import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, HistoryServiceError, type HistoryStore } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";

test("the Registrar history port creates without id and resumes reads and lists from their cursors", { timeout: 5000 }, async t => {
  type Page = Awaited<ReturnType<HistoryStore["read"]>>;
  const records = new Map<string, Page>();
  const active = new Map<string, AbortController>();
  const readCursors = new Map<string, (string | undefined)[]>();
  const listCursors: (string | undefined)[] = [];
  const released: string[] = [];
  const store: HistoryStore = {
    ttlMs: 15_000, persistent: true,
    create(id, metadata) {
      assert.ok(!Object.hasOwn(metadata, "id"));
      assert.equal(metadata.project, process.cwd());
      assert.equal(typeof metadata.created, "number");
      assert.ok(!records.has(id));
      records.set(id, { session: { ...metadata, id }, entries: [] });
    },
    acquire(id, owner) {
      assert.ok(records.has(id));
      assert.ok(owner);
      assert.ok(!active.has(id));
      active.set(id, new AbortController());
      return `lease-${id}`;
    },
    renew(id, lease) { assert.ok(active.has(id)); assert.equal(lease, `lease-${id}`); },
    release(id, lease) {
      assert.ok(active.delete(id));
      assert.equal(lease, `lease-${id}`);
      released.push(id);
    },
    writerSignal: id => active.get(id)?.signal,
    append(id, lease, entries) {
      assert.ok(active.has(id));
      assert.equal(lease, `lease-${id}`);
      records.get(id)!.entries.push(...entries);
      return entries.length;
    },
    read(id, { after, limit }) {
      assert.equal(limit, 500);
      readCursors.set(id, [...readCursors.get(id) ?? [], after]);
      const record = records.get(id);
      if (!record) throw new HistoryServiceError("unknown_session", "No record");
      return { session: record.session, ...oneRow(record.entries, after) };
    },
    list({ project, after, limit }) {
      if (project !== undefined) assert.equal(project, process.cwd());
      assert.equal(limit, 500);
      if (project !== undefined) listCursors.push(after);
      const rows = [...records.values()].filter(r => r.entries.length).map(r => r.session).reverse();
      const { entries, next } = oneRow(rows, after);
      return { sessions: entries, next };
    },
  };
  const agent = await testAgent({ durability: "kept", script: [{ text: "Done" }],
    plugins: [definePlugin({ name: "paged-history", replaces: ["history-store"], setup: r => r.historyStore(store) })],
  });
  t.after(() => agent.close());
  const first = await agent.session({ settings: { title: "One" } });
  const second = await agent.session({ settings: { title: "Two" } });
  assert.equal(records.size, 0, "create is deferred until the first admitted input");
  assert.equal((await first.prompt("One")).text, "Done");
  assert.equal((await second.prompt("Two")).text, "Done");
  await first.close();
  await second.close();
  assert.deepEqual(released, [first.id, second.id]);
  const sessions = await agent.sessions({ project: process.cwd() });
  assert.deepEqual(sessions.map(s => [s.id, s.title]), [[second.id, "Two"], [first.id, "One"]]);
  assert.deepEqual(listCursors, [undefined, second.id]);
  for (const id of [first.id, second.id]) {
    assert.deepEqual(readCursors.get(id), [undefined, ...records.get(id)!.entries.slice(0, -1).map(e => e.id)]);
  }
  const reopened = await agent.openSession(first.id);
  assert.equal((await reopened.lastTurn())?.text, "Done");
  const last = (await reopened.history()).at(-1)!.id;
  const follower = reopened.events(last)[Symbol.asyncIterator]();
  const pending = follower.next();
  active.get(first.id)!.abort();
  assert.deepEqual((await pending).value?.data, { reason: "writerLost" });
  assert.equal((await follower.next()).done, true);
});

// Force continuation at the store boundary, as when a page hits the byte cap.
function oneRow<T extends { id: string }>(rows: T[], after?: string): { entries: T[]; next?: string } {
  const i = after === undefined ? 0 : rows.findIndex(row => row.id === after) + 1;
  if (after !== undefined) assert.ok(i > 0, "cursor is a kept id");
  const entries = rows.slice(i, i + 1);
  return { entries, next: i + 1 < rows.length ? entries[0].id : undefined };
}
