import type { HistoryStore, HistoryEntry, StoredSession } from "@modular-agent/harness";
import { AgentError } from "./errors.js";
import { isDeepStrictEqual } from "node:util";

export class MemoryHistory implements HistoryStore {
  supports = { portableSessions: false, erasure: false };
  #records = new Map<string, { meta: StoredSession; entries: HistoryEntry[] }>();
  #writers = new Set<string>();
  #get(id: string) {
    const record = this.#records.get(id);
    if (!record) throw new AgentError("not_found", `No session ${id}`);
    return record;
  }
  async create(meta: StoredSession) {
    if (this.#records.has(meta.id)) throw new AgentError("conflict", "Session already exists");
    this.#records.set(meta.id, { meta: structuredClone(meta), entries: [] });
  }
  async openForWriting(id: string) {
    this.#get(id);
    if (this.#writers.has(id)) throw new AgentError("held", "History is held", { retryAfterMs: 0 });
    this.#writers.add(id);
  }
  async close(id: string) { this.#writers.delete(id); }
  async append(id: string, entries: HistoryEntry[]) {
    if (!this.#writers.has(id)) throw new AgentError("lost", "No history writer");
    const record = this.#get(id);
    const next = new Map(record.entries.map(e => [e.id, e]));
    for (const entry of entries) {
      const prior = next.get(entry.id);
      if (prior && !isDeepStrictEqual(prior, entry)) throw new AgentError("conflict", `Conflicting entry ${entry.id}`);
      if (!prior) next.set(entry.id, structuredClone(entry));
    }
    record.entries = [...next.values()];
  }
  async load(id: string) { return structuredClone(this.#get(id)); }
  async list(filter?: { project?: string }) {
    return [...this.#records.values()].filter(r => !filter?.project || r.meta.project === filter.project)
      .map(r => structuredClone(r.meta));
  }
}
