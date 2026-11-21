import assert from "node:assert/strict";
import type { WriterHistoryStore as HistoryStore } from "@modular-agent/core";

/** A Registrar store with deterministic append failure and lease revocation. */
export function interruptedHistory() {
  const records = new Map<string, Awaited<ReturnType<HistoryStore["load"]>>>();
  const leases = new Map<string, AbortController>();
  let failAppend = false;
  const store: HistoryStore = {
    supports: { persistent: true },
    async create(meta) { records.set(meta.id, { meta, entries: [] }); },
    async openForWriting(id) {
      assert.ok(!leases.has(id));
      leases.set(id, new AbortController());
    },
    writerSignal: id => leases.get(id)?.signal,
    async close(id) { leases.get(id)?.abort(); leases.delete(id); },
    async append(id, batch) {
      leases.get(id)?.signal.throwIfAborted();
      if (failAppend) { failAppend = false; throw new Error("fixture append failure"); }
      records.get(id)!.entries.push(...structuredClone(batch));
    },
    async load(id) { return structuredClone(records.get(id)!); },
    async list() { return [...records.values()].map(r => r.meta); },
  };
  return {
    store,
    failNextAppend() { failAppend = true; },
    revoke(id: string) { leases.get(id)!.abort(new Error("fixture lease revoked")); },
  };
}
