import type { JsonObject } from "./history-json.js";

export interface HistoryReadOptions { after?: string; limit: number }
export interface HistoryPage { session: JsonObject; entries: JsonObject[]; next?: string }
export interface HistorySessionPage { sessions: JsonObject[]; next?: string }

type Awaitable<T> = T | Promise<T>;

/** Storage half of history/1. The store owns atomicity, paging, durability, lease
 * fencing and restart exclusion. Preserve opaque fields and exact JSON numbers.
 * HTTP calls on separate connections can overlap. Yield during slow I/O and keep
 * renewal independent of storage locks and queues held by other sessions. */
export interface HistoryServiceStore {
  readonly ttlMs: number;
  readonly retention?: number | null;
  /** Create or check identical metadata. The metadata does not include id. */
  create(id: string, metadata: JsonObject): Awaitable<void>;
  list(options: HistoryReadOptions & { project?: string }): Awaitable<HistorySessionPage>;
  read(id: string, options: HistoryReadOptions): Awaitable<HistoryPage>;
  acquire(id: string, owner: string): Awaitable<string>;
  renew(id: string, lease: string): Awaitable<void>;
  release(id: string, lease: string): Awaitable<void>;
  append(id: string, lease: string, entries: JsonObject[]): Awaitable<number>;
  erase(id: string, entryIds: string[], lease?: string): Awaitable<string[]>;
}

export const historyStorageStatuses = {
  unknown_session: 404, unknown_entry: 404, conflict: 409, held: 409, lost: 409, entry_too_large: 413, unavailable: 503,
} as const;
export type HistoryServiceErrorCode = keyof typeof historyStorageStatuses;
/** A confirmed refusal. Other exceptions from a mutation leave its reply uncertain. */
export class HistoryServiceError extends Error {
  constructor(readonly code: HistoryServiceErrorCode, message: string, readonly retryAfterMs?: number) { super(message); }
}
