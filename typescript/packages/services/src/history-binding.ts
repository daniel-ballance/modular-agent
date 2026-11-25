import type { Json, JsonObject } from "./history-json.js";

export const HISTORY_BINDING = "modular-agent-history/1";
export const maxBody = 64 * 1024 * 1024;
export const maxPage = 4 * 1024 * 1024;
export const id = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export const MAX_LEASE_BYTES = 128;
export const validLease = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= MAX_LEASE_BYTES && !/[^A-Za-z0-9_-]/.test(v);
export const ids = (v: Json | undefined): v is string[] => Array.isArray(v) && v.every(id);
export const distinctIds = (v: Json | undefined): v is string[] => ids(v) && v.length > 0 && new Set(v).size === v.length;
export const fields = (v: JsonObject, ...keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
export class BindingError extends Error {
	constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs?: number) { super(message); }
}
export class UncertainCommit extends Error {}
export const invalid = (message: string): never => { throw new BindingError(400, "invalid_request", message); };
export const unavailable = () => new BindingError(503, "unavailable", "History storage is temporarily unavailable");
export const unknownSession = () => new BindingError(404, "unknown_session", "Unknown session");
export const conflict = () => new BindingError(409, "conflict", "The ID is reserved with different content or has expired");
export const held = (until: number) => new BindingError(409, "held", "Session is held by another owner or temporarily excluded", Math.max(1, Math.ceil(until - performance.now())));

export const lost = () => new BindingError(409, "lost", "Lease is not current");
