import { BindingError, UncertainCommit, invalid, unavailable, unknownSession, held, lost, id, ids, distinctIds, fields, validLease, maxPage } from "./history-binding.js";
import { encodeJson, object, parseJson, type Json, type JsonObject } from "./history-json.js";
import { Records, validateMetadata, type Session, type CopySet } from "./history-records.js";
import { HistoryServiceError, historyStorageStatuses, type HistoryServiceStore } from "./history-backend.js";
import type { HistoryLeases, Lease } from "./history-leases.js";

type PageQuery = { after?: string; limit: number; project?: string };
export type HistoryRequest = PageQuery & {
	op: "list" | "session" | "acquire" | "renew" | "release" | "append" | "erase" | "plans" | "complete";
	method: string; sid: string; param: string; raw: Uint8Array; revisionHeaders?: string[];
};
export type HistoryReply = { json: string; grant?: Lease; noStore?: boolean };

const decodeBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function bodyObject(raw: Uint8Array, expected: boolean): JsonObject {
	if (!expected) { if (raw.length) invalid("This operation takes no body"); return {}; }
	let b: Json;
	try { b = parseJson(decodeBody.decode(raw)); } catch { return invalid("Expected one UTF-8 JSON object"); }
	if (!object(b)) return invalid("Expected one UTF-8 JSON object");
	return b;
}

function builtInStore(records: Records, leases: HistoryLeases, ttlMs: number, expires: (session: Session) => boolean, localHeld?: (id: string) => boolean) {
	const known = (sid: string) => records.session(sid, expires) ?? (() => { throw unknownSession(); })();
	const checkHold = () => { if (records.holdUntil > performance.now()) throw held(records.holdUntil); };
	return {
		create: (sid: string, metadata: JsonObject) => records.put(sid, metadata, expires),
		list: ({ project, after, limit }: PageQuery) => records.list(project, after, limit, expires),
		read: (sid: string, { after, limit }: PageQuery) => records.read(known(sid), after, limit),
		acquire(sid: string, owner: string) {
			known(sid);
			checkHold();
			if (localHeld?.(sid)) throw held(performance.now() + ttlMs);
			return leases.acquire(sid, owner);
		},
		renew(sid: string) { known(sid); throw lost(); },
		release(sid: string, lease: string) { known(sid); leases.release(sid, lease); },
		append(sid: string, lease: string, entries: JsonObject[], revision?: string) {
			const s = known(sid), authorize = () => { leases.require(sid, lease); };
			return records.keep(s, entries, authorize, revision);
		},
		erase(sid: string, entryIds: string[], lease?: string) {
			const s = known(sid);
			const authorize = () => {
				if (lease !== undefined) { leases.require(sid, lease); return; }
				checkHold();
				if (localHeld?.(sid)) throw held(performance.now() + ttlMs);
				const l = leases.current(sid);
				if (l) throw held(performance.now() + l.remaining);
			};
			authorize();
			return records.erase(s, entryIds, authorize).erased;
		},
	};
}

const encodePage = (value: string | JsonObject) => {
	if (typeof value === "string") return value;
	const json = encodeJson(value);
	if (Buffer.byteLength(json) > maxPage) throw unavailable();
	return json;
};

export async function historyRequest(request: HistoryRequest, ttlMs: number, profile: boolean,
	custom?: HistoryServiceStore, records?: Records, leases?: HistoryLeases, localHeld?: (id: string) => boolean): Promise<HistoryReply> {
	const { op, method, sid, param, raw, after, limit, project, revisionHeaders } = request;
	const reading = method === "GET";
	const expires = (s: Session) => records!.retention !== null && !leases!.current(s.id) && records!.now() - s.changed >= records!.retention;
	const store = custom ?? builtInStore(records!, leases!, ttlMs, expires, localHeld);
	const mutate = async <T>(operation: () => T | Promise<T>): Promise<T> => {
		try { return await operation(); }
		catch (error) {
			if (custom && !(error instanceof HistoryServiceError && Object.hasOwn(historyStorageStatuses, error.code))) throw new UncertainCommit();
			throw error;
		}
	};

	const b = bodyObject(raw, method === "PUT" || op === "acquire" || op === "append" || op === "erase" || op === "complete" || (op === "plans" && !reading));
	records?.check();
	let result: unknown = {};
	let grant: Lease | undefined;
	switch (op) {
		case "list": {
			const page = await store.list({ project, after, limit });
			return { json: encodePage(typeof page === "string" ? page : {
				sessions: page.sessions, ...(page.next === undefined ? {} : { next: page.next }),
			}) };
		}
		case "session": {
			if (reading) {
				const page = await store.read(sid, { after, limit });
				return { json: encodePage(typeof page === "string" ? page : {
					session: page.session, entries: page.entries, ...(page.next === undefined ? {} : { next: page.next }),
				}) };
			}
			validateMetadata(sid, b);
			await mutate(() => store.create(sid, b));
			break;
		}
		case "acquire": {
			const owner = b.owner;
			if (!id(owner)) return invalid("owner is required");
			const acquired = await mutate(() => store.acquire(sid, owner));
			const lease = typeof acquired === "string" ? acquired : acquired.token;
			if (typeof acquired !== "string") grant = acquired;
			if (!validLease(lease)) throw new UncertainCommit();
			result = { lease, ttlMs };
			break;
		}
		case "renew":
			await mutate(() => store.renew(sid, param));
			result = { ttlMs };
			break;
		case "release":
			await mutate(() => store.release(sid, param));
			break;
		case "append": {
			const { lease, entries } = b;
			if (!validLease(lease) || !Array.isArray(entries) || !entries.every((e) => object(e) && id(e.id) && (e.parentId === null || id(e.parentId)) && e.erased !== true)) return invalid("Invalid lease or entries");
			const revisions = profile && revisionHeaders;
			if (revisions && (revisions.length !== 1 || !validLease(revisions[0]))) return invalid("Invalid History-Revision header");
			const kept = await mutate(() => store.append(sid, lease, entries as JsonObject[], revisions ? revisions[0] : undefined));
			if (!Number.isSafeInteger(kept) || kept < 0 || kept > entries.length) throw new UncertainCommit();
			result = { kept };
			break;
		}
		case "plans": {
			if (reading) {
				return { json: records!.plans(sid, after, limit), noStore: true };
			}
			const { lease, revision, intentId, entryIds, copies } = b;
			if (!fields(b, "lease", "revision", "intentId", "entryIds", "copies") || !validLease(lease) || !validLease(revision) ||
				!id(intentId) || intentId === "." || intentId === ".." || !distinctIds(entryIds) || !Array.isArray(copies) || !copies.length) return invalid("Invalid erasure publication");
			const sets = new Map<string, CopySet>();
			for (const copy of copies) {
				if (!object(copy) || !fields(copy, "sessionId", "recordId", "entryIds") || !id(copy.sessionId) || copy.sessionId === "." || copy.sessionId === ".." ||
					!id(copy.recordId) || !distinctIds(copy.entryIds) || sets.has(copy.sessionId)) return invalid("Invalid erasure copy set");
				sets.set(copy.sessionId, { sessionId: copy.sessionId, recordId: copy.recordId, entryIds: copy.entryIds });
			}
			const source = new Set(sets.get(sid)?.entryIds);
			if (entryIds.some(id => !source.has(id))) return invalid("Copy sets must cover the source targets");
			if (!records!.session(sid, expires)) throw unknownSession();
			result = records!.publish(sid, { revision, intentId, entryIds, copies: [...sets.values()] }, () => leases!.require(sid, lease), expires);
			break;
		}
		case "complete": {
			const { lease, entryIds } = b;
			if (!fields(b, "lease", "entryIds") || !validLease(lease) || !distinctIds(entryIds)) return invalid("Invalid erasure completion");
			if (!records!.session(sid, expires)) throw unknownSession();
			records!.complete(sid, param, entryIds, () => leases!.require(sid, lease));
			break;
		}
		case "erase": {
			const { entryIds, lease } = b;
			if (!ids(entryIds) || (Object.hasOwn(b, "lease") && !validLease(lease))) return invalid("Invalid entry IDs or lease");
			const erased = await mutate(() => store.erase(sid, entryIds, lease as string | undefined));
			if (!Array.isArray(erased) || !erased.every(id)) throw new UncertainCommit();
			result = { erased };
			break;
		}
	}
	return { json: JSON.stringify(result), grant };
}
