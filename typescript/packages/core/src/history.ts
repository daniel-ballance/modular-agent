import { HistoryArchive } from "@modular-agent/services";

const archives = new WeakMap<MemoryHistory, HistoryArchive>();
export class MemoryHistory {
  declare private readonly memory: true;
  constructor() { archives.set(this, new HistoryArchive()); }
}
export const memoryArchive = (history: MemoryHistory) => archives.get(history)!;
export const memoryStore = (history: MemoryHistory) => memoryArchive(history).store();
