import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { filePendingErasure, memoryPendingErasure, type PendingErasure } from "@modular-agent/harness";
import type { HistoryEntry, HistoryStore, StoredSession } from "@modular-agent/harness";
import { count, encodeJson, equalJson, nonnegativeNumber, object, parseJson, type Json, type JsonObject } from "./history-json.js";
import { HistoryServiceError, historyStorageStatuses, type HistoryServiceStore } from "./history-backend.js";

export const HISTORY_BINDING = "modular-agent-history/1";
const maxBody = 64 * 1024 * 1024;
const maxPage = 4 * 1024 * 1024;
const bytes = Buffer.byteLength;
const decodeBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export const MAX_LEASE_BYTES = 128;
export const validLease = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= MAX_LEASE_BYTES && !/[^A-Za-z0-9_-]/.test(v);
const ids = (v: Json | undefined): v is string[] => Array.isArray(v) && v.every(id);
const distinctIds = (v: Json | undefined): v is string[] => ids(v) && v.length > 0 && new Set(v).size === v.length;
const fields = (v: JsonObject, ...keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
type CopySet = { sessionId: string; recordId: string; entryIds: string[] };
type Publication = { revision: string; intentId: string; entryIds: string[]; copies: CopySet[] };
type Plan = { intentId: string; sourceSessionId: string; recordId: string; copies: { entryId: string; complete: boolean }[] };
const planFrame = (revision: string) => `{"revision":${JSON.stringify(revision)},"plans":[`;
const sortIds = (values: string[]) => [...values].sort();
const copyKey = (copies: CopySet[]) => JSON.stringify(copies.map(c => JSON.stringify([c.sessionId, c.recordId, sortIds(c.entryIds)])).sort());
const unknownIntent = () => new BindingError(404, "unknown_intent", "Unknown erasure intent");
const unknownEntry = () => new BindingError(404, "unknown_entry", "Unknown erasure target");

class BindingError extends Error {
	constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs?: number) { super(message); }
}
class UncertainCommit extends Error {}
const invalid = (message: string): never => { throw new BindingError(400, "invalid_request", message); };
const unavailable = () => new BindingError(503, "unavailable", "History storage is temporarily unavailable");
const unknownSession = () => new BindingError(404, "unknown_session", "Unknown session");
const conflict = () => new BindingError(409, "conflict", "The ID is reserved with different content or has expired");
const held = (until: number) => new BindingError(409, "held", "Session is held by another owner or temporarily excluded", Math.max(1, Math.ceil(until - performance.now())));

export function historyTombstone(e: JsonObject): JsonObject {
	const kind = typeof e.kind === "string" ? e.kind : null;
	const t: JsonObject = { id: e.id, parentId: e.parentId, kind, erased: true };
	for (const k of ["turnId", "stepId", "toolCallId", "jobId", "inputId", "requestId", "continuesTurnId"]) {
		if (typeof e[k] === "string") t[k] = e[k];
	}
	const d = object(e.data) ? e.data : undefined;
	if (kind === "inputAccepted" || kind === "input" || kind === "inputHandedBack") {
		if (!Object.hasOwn(e, "inputId") && id(d?.inputId)) t.inputId = d.inputId;
		if (kind === "inputHandedBack" && !Object.hasOwn(e, "inputId") && !(d && Object.hasOwn(d, "inputId")) && ids(d?.inputIds) && d.inputIds.length) t.inputIds = d.inputIds;
	}
	if ((kind === "inputRequest" || kind === "inputAnswer") && !Object.hasOwn(e, "requestId")) {
		if (id(d?.requestId)) t.requestId = d.requestId;
		else if (kind === "inputRequest" && object(d?.request) && id(d.request.id)) t.requestId = d.request.id;
	}
	if (kind === "turnStart" && !Object.hasOwn(e, "continuesTurnId") && id(d?.continuesTurnId)) t.continuesTurnId = d.continuesTurnId;
	if (ids(e.sources)) t.sources = e.sources;
	const usage = kind === "response" && object(e.message) ? e.message.usage : kind === "jobEnded" || kind === "turnEnd" ? d?.usage : undefined;
	if (object(usage) && ["input", "output", "cacheRead", "cacheWrite"].every((k) => count(usage[k]) !== undefined) && nonnegativeNumber(usage.cost)) {
		t.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost };
	}
	if (kind === "jobStarted" && id(e.writer) && id(d?.key)) { t.writer = e.writer; t.jobKey = d.key; }
	return t;
}

type Row = { id: string; json: string };
type Session = Row & { created: number; project: string; changed: number; expired: number };
const frame = (meta?: string) => meta === undefined ? '{"sessions":[' : `{"session":${meta},"entries":[`;
const tail = (next?: string) => next === undefined ? "]}" : `],"next":${JSON.stringify(next)}}`;
const fits = (prefix: string, json: string, next: string) => bytes(prefix) + bytes(json) + bytes(tail(next)) <= maxPage;

/** Select the longest fitting prefix; the cursor itself counts toward the cap. */
function page(prefix: string, rows: Iterable<Row>, limit: number): string {
	const cursor = rows[Symbol.iterator]();
	try {
		const included: Row[] = [];
		let best = 0, next: string | undefined;
		let size = bytes(prefix);
		let row = cursor.next();
		while (!row.done && included.length < limit) {
			const item = row.value;
			size += bytes(item.json) + (included.length ? 1 : 0);
			if (size + 2 > maxPage) break;
			included.push(item);
			row = cursor.next();
			const candidate = row.done ? undefined : item.id;
			if (size + bytes(tail(candidate)) <= maxPage) { best = included.length; next = candidate; }
		}
		if (!best && (included.length || !row.done)) throw unavailable();
		return prefix + included.slice(0, best).map((r) => r.json).join(",") + tail(next);
	} finally { cursor.return?.(); }
}

class Records {
	private db: DatabaseSync;
	private failed = false;
	private registryFailed = false;
	holdUntil = 0;
	ttlEpoch = 0;

	constructor(dir: string | undefined, ttl: number, readonly retention: number | null, private quota: number) {
		if (dir !== undefined) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (readdirSync(dir).some((name) => name.endsWith(".jsonl"))) throw new Error("Legacy history directory has no verifiable lease bound; use a fresh directory");
		}
		this.db = new DatabaseSync(dir === undefined ? ":memory:" : join(dir, "history.sqlite"));
		try {
			// The retained exclusive lock prevents two service processes from
			// managing independent lease maps over the same store. FULL sync
			// and a rollback journal make a whole batch the durable unit.
			this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
				BEGIN EXCLUSIVE;
				CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL, created INTEGER NOT NULL, project TEXT NOT NULL, changed INTEGER NOT NULL, expired INTEGER NOT NULL DEFAULT 0);
				CREATE INDEX IF NOT EXISTS session_order ON sessions (created DESC, id);
				CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, session TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, UNIQUE (session,id));
				CREATE INDEX IF NOT EXISTS entry_order ON entries (session,seq);`);
			if (!this.db.prepare("SELECT 1 FROM settings WHERE key='pending-erasure-profile'").get()) {
				this.db.exec(`CREATE TABLE registry_revision (revision TEXT NOT NULL);
					CREATE TABLE registry_intents (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, operation TEXT UNIQUE NOT NULL, copies TEXT NOT NULL);
					CREATE TABLE registry_plans (session TEXT NOT NULL, intent INTEGER NOT NULL, record TEXT NOT NULL, json TEXT NOT NULL,
						PRIMARY KEY (session,intent), UNIQUE (session,record));
					INSERT INTO settings VALUES ('pending-erasure-profile',1);`);
				this.db.prepare("INSERT INTO registry_revision VALUES (?)").run(randomBytes(32).toString("hex"));
			}
			try {
				this.revision();
				this.db.prepare("SELECT seq,id,operation,copies FROM registry_intents LIMIT 1").get();
				this.db.prepare("SELECT session,intent,record,json FROM registry_plans LIMIT 1").get();
			} catch { this.registryFailed = true; }
			const prior = this.db.prepare("SELECT value FROM settings WHERE key='ttl-bound'").get()?.value;
			if (prior === undefined && this.db.prepare("SELECT 1 FROM sessions LIMIT 1").get()) throw new Error("Stored TTL bound is missing");
			if (prior !== undefined && (typeof prior !== "number" || !Number.isSafeInteger(prior) || prior < 0)) throw new Error("Stored TTL bound is invalid");
			const bound = Math.max(prior ?? 0, ttl);
			this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('ttl-bound',?)").run(bound);
			if (ttl > 0) this.bumpTtlEpoch();
			else this.ttlEpoch = Number(this.db.prepare("SELECT value FROM settings WHERE key='ttl-epoch'").get()?.value ?? 0);
			this.db.exec("COMMIT");
			this.holdUntil = prior === undefined ? 0 : performance.now() + bound;
		} catch (error) { this.db.close(); throw error; }
	}
	close() { this.db.close(); }
	private bumpTtlEpoch() {
		this.db.exec("INSERT INTO settings VALUES ('ttl-epoch',1) ON CONFLICT(key) DO UPDATE SET value=value+1");
		this.ttlEpoch = Number(this.db.prepare("SELECT value FROM settings WHERE key='ttl-epoch'").get()!.value);
	}
	bindTtl(ttl: number) {
		this.commit(() => {
			this.db.prepare("UPDATE settings SET value=MAX(value,?) WHERE key='ttl-bound'").run(ttl);
			this.bumpTtlEpoch();
		});
	}
	check() { if (this.failed) throw unavailable(); }
	private commit<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		let committing = false;
		try {
			const result = operation();
			committing = true;
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { this.failed = true; }
			if (committing || this.failed) { this.failed = true; throw new UncertainCommit(); }
			throw error;
		}
	}

	session(sid: string, expires: (s: Session) => boolean): Session | undefined {
		const row = this.db.prepare("SELECT * FROM sessions WHERE id=? AND NOT expired").get(sid) as Session | undefined;
		if (!row || !expires(row)) return row;
		this.commit(() => {
			this.db.prepare("UPDATE sessions SET expired=1,json='',project='' WHERE id=?").run(sid);
			this.db.prepare("DELETE FROM entries WHERE session=?").run(sid);
			this.advanceRevision();
		});
	}
	put(sid: string, initial: JsonObject, expires: (s: Session) => boolean) {
		const meta = { ...initial, id: sid };
		const json = encodeJson(meta);
		const row = this.session(sid, expires);
		if (row) { if (!equalJson(row.json, meta)) throw conflict(); return; }
		if (this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sid)) throw conflict();
		if (this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n as number >= this.quota) throw unavailable();
		this.commit(() => {
			this.db.prepare("INSERT INTO sessions (id,json,created,project,changed) VALUES (?,?,?,?,?)").run(sid, json, count(initial.created)!, initial.project as string, Date.now());
			this.advanceRevision();
		});
	}
	list(project: string | undefined, after: string | undefined, limit: number, expires: (s: Session) => boolean) {
		const visible = "NOT expired AND EXISTS (SELECT 1 FROM entries WHERE entries.session=sessions.id)";
		const which = project === undefined ? visible : visible + " AND project=?";
		const args = project === undefined ? [] : [project];
		if (this.retention !== null) {
			const old = this.db.prepare(`SELECT id FROM sessions WHERE NOT expired AND changed<=?`).all(Date.now() - this.retention) as { id: string }[];
			for (const row of old) this.session(row.id, expires);
		}
		const cursor = after === undefined ? undefined : this.db.prepare(`SELECT created,id FROM sessions WHERE ${which} AND id=?`).get(...args, after) as Pick<Session, "created" | "id"> | undefined;
		if (after !== undefined && !cursor) throw unknownSession();
		return page(frame(), this.db.prepare(`SELECT id,json FROM sessions WHERE ${which}${cursor ? " AND (created<? OR (created=? AND id>?))" : ""} ORDER BY created DESC,id LIMIT ?`).iterate(...args, ...(cursor ? [cursor.created, cursor.created, cursor.id] : []), limit + 1) as Iterable<Row>, limit);
	}
	read(s: Session, after: string | undefined, limit: number) {
		const at = after === undefined ? 0 : this.db.prepare("SELECT seq FROM entries WHERE session=? AND id=?").get(s.id, after)?.seq as number | undefined;
		if (at === undefined) throw new BindingError(404, "unknown_entry", "Unknown entry cursor");
		return page(frame(s.json), this.db.prepare("SELECT id,json FROM entries WHERE session=? AND seq>? ORDER BY seq LIMIT ?").iterate(s.id, at, limit + 1) as Iterable<Row>, limit);
	}
	keep(s: Session, batch: JsonObject[], authorize: () => void, revision?: string) {
		const prefix = frame(s.json);
		let kept = 0;
		const find = this.db.prepare("SELECT json FROM entries WHERE session=? AND id=?");
		const insert = this.db.prepare("INSERT INTO entries (session,id,json) VALUES (?,?,?)");
		return this.commit(() => {
			authorize();
			if (revision !== undefined) this.requireRevision(revision);
			for (const e of batch) {
				const eid = e.id as string;
				const known = find.get(s.id, eid)?.json as string | undefined;
				if (known !== undefined) { if (!equalJson(known, e)) throw conflict(); continue; }
				const json = encodeJson(e);
				if (!fits(prefix, json, eid) || !fits(prefix, encodeJson(historyTombstone(e)), eid)) throw new BindingError(413, "entry_too_large", "Entry cannot fit a read page");
				insert.run(s.id, eid, json);
				kept++;
			}
			authorize();
			if (kept) this.changed(s.id);
			return kept;
		});
	}
	erase(s: Session, targets: string[], authorize: () => void) {
		const find = this.db.prepare("SELECT json FROM entries WHERE session=? AND id=?");
		const replace = this.db.prepare("UPDATE entries SET json=? WHERE session=? AND id=?");
		return this.commit(() => {
			const erased: string[] = [];
			let changed = false;
			for (const eid of new Set(targets)) {
				const known = find.get(s.id, eid)?.json as string | undefined;
				if (known === undefined) continue;
				erased.push(eid);
				const entry = parseJson(known) as JsonObject;
				if (entry.erased === true) continue;
				replace.run(encodeJson(historyTombstone(entry)), s.id, eid);
				changed = true;
			}
			authorize();
			if (changed) this.changed(s.id);
			return { erased };
		});
	}
	private changed(sid: string) {
		this.db.prepare("UPDATE sessions SET changed=? WHERE id=?").run(Date.now(), sid);
		this.advanceRevision();
	}
	private revision() {
		if (this.registryFailed) throw unavailable();
		const rows = this.db.prepare("SELECT revision FROM registry_revision LIMIT 2").all();
		if (rows.length !== 1 || !validLease(rows[0].revision)) throw unavailable();
		return rows[0].revision;
	}
	private requireRevision(revision: string) {
		if (this.revision() !== revision) throw new BindingError(409, "stale_revision", "History has changed");
	}
	private advanceRevision() {
		this.revision();
		this.db.prepare("UPDATE registry_revision SET revision=?").run(randomBytes(32).toString("hex"));
	}
	plans(sid: string, after: string | undefined, limit: number) {
		const revision = this.revision();
		if (!this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sid)) throw unknownSession();
		const at = after === undefined ? 0 : this.db.prepare(`SELECT intent FROM registry_plans
			JOIN registry_intents ON seq=intent WHERE session=? AND id=?`).get(sid, after)?.intent as number | undefined;
		if (at === undefined) throw unknownIntent();
		return page(planFrame(revision), this.db.prepare(`SELECT id,json FROM registry_plans
			JOIN registry_intents ON seq=intent WHERE session=? AND intent>? ORDER BY intent LIMIT ?`).iterate(sid, at, limit + 1) as Iterable<Row>, limit);
	}
	publish(sid: string, request: Publication, authorize: () => void, expires: (s: Session) => boolean) {
		const { revision, intentId, entryIds, copies } = request;
		const operation = JSON.stringify([sid, sortIds(entryIds)]);
		// Expiry is applied at lookup. Do not open a nested transaction when checking destinations.
		return this.commit(() => {
			authorize();
			this.revision();
			const sameId = this.db.prepare("SELECT operation,copies FROM registry_intents WHERE id=?").get(intentId);
			const key = copyKey(copies);
			if (sameId && (sameId.operation !== operation || sameId.copies !== key)) throw conflict();
			const prior = this.db.prepare("SELECT id FROM registry_intents WHERE operation=?").get(operation);
			if (prior) return { intentId: prior.id };
			this.requireRevision(revision);
			const select = this.db.prepare("SELECT * FROM sessions WHERE id=? AND NOT expired");
			for (const copy of copies) {
				const destination = select.get(copy.sessionId) as Session | undefined;
				if (!destination || expires(destination)) throw unknownSession();
			}
			const entry = this.db.prepare("SELECT 1 FROM entries WHERE session=? AND id=?");
			const reserved = this.db.prepare("SELECT 1 FROM registry_plans WHERE session=? AND record=?");
			const plans = copies.map(copy => {
				if (copy.entryIds.some(id => !entry.get(copy.sessionId, id))) throw unknownEntry();
				if (entry.get(copy.sessionId, copy.recordId) || reserved.get(copy.sessionId, copy.recordId)) throw conflict();
				const plan: Plan = { intentId, sourceSessionId: sid, recordId: copy.recordId,
					copies: copy.entryIds.map(entryId => ({ entryId, complete: false })) };
				const json = JSON.stringify(plan);
				if (!fits(planFrame("x".repeat(MAX_LEASE_BYTES)), json, intentId)) throw new BindingError(413, "request_too_large", "Erasure plan cannot fit a read page");
				return json;
			});
			const { lastInsertRowid } = this.db.prepare("INSERT INTO registry_intents (id,operation,copies) VALUES (?,?,?)").run(intentId, operation, key);
			const insert = this.db.prepare("INSERT INTO registry_plans VALUES (?,?,?,?)");
			copies.forEach((copy, i) => insert.run(copy.sessionId, lastInsertRowid, copy.recordId, plans[i]));
			authorize();
			this.advanceRevision();
			return { intentId };
		});
	}
	complete(sid: string, intentId: string, entryIds: string[], authorize: () => void) {
		this.commit(() => {
			authorize();
			this.revision();
			const row = this.db.prepare(`SELECT intent,json FROM registry_plans
				JOIN registry_intents ON seq=intent WHERE session=? AND id=?`).get(sid, intentId);
			if (!row) throw unknownIntent();
			const plan = JSON.parse(row.json as string) as Plan;
			const copies = new Map(plan.copies.map(copy => [copy.entryId, copy]));
			if (entryIds.some(id => !copies.has(id))) invalid("Entry is not in the erasure plan");
			const get = this.db.prepare("SELECT json FROM entries WHERE session=? AND id=?");
			const read = (id: string) => {
				const row = get.get(sid, id);
				return row && parseJson(row.json as string) as JsonObject;
			};
			const record = read(plan.recordId);
			const listed = record && object(record.data) && ids(record.data.entryIds) ? new Set(record.data.entryIds) : new Set();
			if (!record || record.erased === true || record.kind !== "erasure" || entryIds.some(id => !listed.has(id) || read(id)?.erased !== true)) throw conflict();
			authorize();
			if (entryIds.every(id => copies.get(id)!.complete)) return;
			for (const id of entryIds) copies.get(id)!.complete = true;
			this.db.prepare("UPDATE registry_plans SET json=? WHERE session=? AND intent=?").run(JSON.stringify(plan), sid, row.intent!);
			this.advanceRevision();
		});
	}
}

const routes = [
	[/^\/v1$/, ["GET"], "version"],
	[/^\/v1\/sessions$/, ["GET"], "list"],
	[/^\/v1\/sessions\/([^/]+)$/, ["GET", "PUT"], "session"],
	[/^\/v1\/sessions\/([^/]+)\/lease$/, ["POST"], "acquire"],
	[/^\/v1\/sessions\/([^/]+)\/lease\/([^/]+)\/renew$/, ["POST"], "renew"],
	[/^\/v1\/sessions\/([^/]+)\/lease\/([^/]+)$/, ["DELETE"], "release"],
	[/^\/v1\/sessions\/([^/]+)\/entries$/, ["POST"], "append"],
	[/^\/v1\/sessions\/([^/]+)\/erase$/, ["POST"], "erase"],
	[/^\/v1\/sessions\/([^/]+)\/pending-erasure$/, ["GET", "POST"], "plans"],
	[/^\/v1\/sessions\/([^/]+)\/pending-erasure\/([^/]+)\/complete$/, ["POST"], "complete"],
] as const;

const digest = (s: string) => createHash("sha256").update(s).digest();
function decode(segment: string) {
	try { return decodeURIComponent(segment); } catch { return invalid("Invalid URL encoding"); }
}
function query(raw: string | undefined, allowed: string[]) {
	const q = new Map<string, string>();
	if (raw) for (const part of raw.split("&")) {
		const eq = part.indexOf("=");
		if (eq === -1) return invalid("Invalid query");
		const name = decode(part.slice(0, eq)), value = decode(part.slice(eq + 1));
		if (!allowed.includes(name) || q.has(name)) return invalid("Unknown or repeated query parameter");
		q.set(name, value);
	}
	const after = q.get("after"), l = q.get("limit");
	const limit = l === undefined ? 500 : Number(l);
	if ((after !== undefined && !id(after)) || (l !== undefined && !/^\d+$/.test(l)) || limit < 1 || limit > 500) return invalid("Invalid cursor or page limit");
	return { after, limit, project: q.get("project") };
}

async function bodyBytes(req: IncomingMessage) {
	const tooLarge = () => new BindingError(413, "request_too_large", "Request body exceeds 64 MiB");
	if (Number(req.headers["content-length"]) > maxBody) throw tooLarge();
	const chunks: Buffer[] = [];
	let size = 0;
	// Destroying the async iterator would tear down the socket before the 413.
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > maxBody) throw tooLarge();
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

function bodyObject(raw: Buffer, expected: boolean): JsonObject {
	if (!expected) { if (raw.length) invalid("This operation takes no body"); return {}; }
	let b: Json;
	try { b = parseJson(decodeBody.decode(raw)); } catch { return invalid("Expected one UTF-8 JSON object"); }
	if (!object(b)) return invalid("Expected one UTF-8 JSON object");
	return b;
}

/** One archive used directly by SDK agents or exposed through the history binding.
 * Direct writers and the HTTP service exclude one another, even in memory. */
export class HistoryArchive {
	private records?: Records;
	private registry?: PendingErasure;
	private exclusion?: { epoch: number; until: number };
	private local = new Map<string, symbol>();
	private remote?: { leased(id: string): boolean; ttl: number };
	constructor(private dir?: string, private pendingErasureDir = dir) {}

	private db() {
		if (!this.records) {
			this.records = new Records(this.dir, 0, null, 100_000);
			if (this.exclusion?.epoch === this.records.ttlEpoch) this.records.holdUntil = this.exclusion.until;
			else this.exclusion = { epoch: this.records.ttlEpoch, until: this.records.holdUntil };
		}
		return this.records;
	}
	private idle() {
		if (this.dir !== undefined && !this.remote && !this.local.size) { this.records?.close(); this.records = undefined; }
	}
	attach(leased: (id: string) => boolean, ttl: number) {
		if (this.remote) throw new Error("This archive is already being served");
		const records = this.db();
		records.bindTtl(ttl);
		this.remote = { leased, ttl };
		return {
			records,
			localHeld: (id: string) => this.local.has(id),
			detach: () => {
				this.remote = undefined;
				records.holdUntil = Math.max(records.holdUntil, performance.now() + ttl);
				this.exclusion = { epoch: records.ttlEpoch, until: records.holdUntil };
				this.idle();
			},
		};
	}
	store(): HistoryStore {
		const owner = Symbol();
		const expires = () => false;
		const read = <T>(operation: (db: Records) => T): T => {
			const db = this.db();
			try { db.check(); return operation(db); }
			finally { this.idle(); }
		};
		const known = (db: Records, id: string) => db.session(id, expires) ?? (() => { throw new BindingError(404, "not_found", "Unknown session"); })();
		const ensureWriter = (id: string) => {
			if (this.local.get(id) !== owner) throw new BindingError(409, "lost", "No history writer");
		};
		return {
			supports: { portableSessions: this.dir !== undefined, persistent: this.dir !== undefined, erasure: true },
			pendingErasure: this.registry ??= this.pendingErasureDir ? filePendingErasure(this.pendingErasureDir) : memoryPendingErasure(),
			create: async ({ id, ...meta }) => read(db => {
				const initial = parseJson(JSON.stringify(meta)) as JsonObject;
				validateMetadata(id, initial);
				db.put(id, initial, expires);
			}),
			openForWriting: async id => read(db => {
				known(db, id);
				if (db.holdUntil > performance.now()) throw held(db.holdUntil);
				if (this.remote?.leased(id) || (this.local.has(id) && this.local.get(id) !== owner)) {
					throw held(performance.now() + (this.remote?.ttl ?? 100));
				}
				this.local.set(id, owner);
			}),
			checkWriter: ensureWriter,
			close: async id => {
				if (this.local.get(id) === owner) this.local.delete(id);
				this.idle();
			},
			append: async (id, batch) => read(db => {
				ensureWriter(id);
				db.keep(known(db, id), parseJson(JSON.stringify(batch)) as JsonObject[], () => ensureWriter(id));
			}),
			load: async id => read(db => {
				const row = known(db, id);
				const entries: HistoryEntry[] = [];
				let next: string | undefined;
				do {
					const page = JSON.parse(db.read(row, next, 500)) as { entries: HistoryEntry[]; next?: string };
					entries.push(...page.entries);
					next = page.next;
				} while (next !== undefined);
				return { meta: JSON.parse(row.json) as StoredSession, entries };
			}),
			list: async filter => read(db => {
				const sessions: StoredSession[] = [];
				let next: string | undefined;
				do {
					const page = JSON.parse(db.list(filter?.project, next, 500, expires)) as { sessions: StoredSession[]; next?: string };
					sessions.push(...page.sessions);
					next = page.next;
				} while (next !== undefined);
				return sessions;
			}),
			erase: async (id, targets) => read(db => {
				const authorize = () => {
					if (this.local.get(id) !== owner && (this.local.has(id) || this.remote?.leased(id) || db.holdUntil > performance.now())) {
						throw held(Math.max(db.holdUntil, performance.now() + 100));
					}
				};
				authorize();
				db.erase(known(db, id), targets, authorize);
			}),
		};
	}
}

function validateMetadata(sid: string, initial: JsonObject) {
	if (Object.hasOwn(initial, "id") || typeof initial.project !== "string" || count(initial.created) === undefined ||
		(Object.hasOwn(initial, "parentSessionId") && !id(initial.parentSessionId)) ||
		(Object.hasOwn(initial, "forkedFrom") && (!object(initial.forkedFrom) || !id(initial.forkedFrom.sessionId) || !id(initial.forkedFrom.entryId)))) invalid("Invalid session metadata");
	const json = encodeJson({ ...initial, id: sid });
	if (!fits(frame(), json, sid) || bytes(frame(json)) + 2 > maxPage) throw new BindingError(413, "request_too_large", "Metadata cannot fit a read page");
}

export interface HistoryServiceOptions {
	dir?: string; archive?: HistoryArchive; store?: HistoryServiceStore; token: string; port?: number; leaseMs?: number; retention?: number | null;
	/** Permanent ID reservations count toward this operator-supplied limit. */
	maxSessions?: number;
	/** Fault injection for the history client tests. */
	dropAppendResponses?: number;
}

/** A single loopback HTTP listener. The operator must trust every local account,
 * provision a random bearer token, and keep this directory on durable local storage. */
export async function historyService(options: HistoryServiceOptions) {
	const ttlMs = options.store?.ttlMs ?? options.leaseMs ?? 15_000;
	const retention = (options.store ? options.store.retention : options.retention) ?? null;
	const quota = options.maxSessions ?? 100_000;
	for (const n of [ttlMs, quota, ...(retention === null ? [] : [retention])]) if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid history service limit");
	if (!/^[A-Za-z0-9._~+/\-]+=*$/.test(options.token)) throw new Error("Invalid history bearer token configuration");
	const token = digest(`Bearer ${options.token}`);
	const leases = new Map<string, { owner: string; lease: string; expires: number }>();
	let drop = options.dropAppendResponses ?? 0;
	let pendingBodies = 0;
	function current(sid: string) {
		const l = leases.get(sid);
		if (l && l.expires > performance.now()) return l;
		if (l) leases.delete(sid);
	}
	function requireLease(sid: string, lease: Json | undefined) {
		const l = current(sid);
		if (!l || l.lease !== lease) throw new BindingError(409, "lost", "Lease is not current");
		return l;
	}
	if (options.archive && retention !== null) throw new Error("An attached SDK archive does not support service retention");
	const attached = options.archive?.attach(sid => current(sid) !== undefined, ttlMs);
	const records = options.store ? undefined : attached?.records ?? new Records(options.dir, ttlMs, retention, quota);
	const closeRecords = () => attached ? attached.detach() : records?.close();
	const expired = (s: Session) => retention !== null && !current(s.id) && Date.now() - s.changed >= retention;
	function builtInStore(records: Records): Omit<HistoryServiceStore, "ttlMs" | "retention" | "read" | "list" | "append"> & {
		append(id: string, lease: string, entries: JsonObject[], revision?: string): number;
		read(sid: string, q: { after?: string; limit: number }): string;
		list(q: { after?: string; limit: number; project?: string }): string;
	} {
		const known = (sid: string) => records.session(sid, expired) ?? (() => { throw unknownSession(); })();
		const checkHold = () => { if (records.holdUntil > performance.now()) throw held(records.holdUntil); };
		return {
			create: (sid, metadata) => records.put(sid, metadata, expired),
			list: ({ project, after, limit }) => records.list(project, after, limit, expired),
			read: (sid, { after, limit }) => records.read(known(sid), after, limit),
			acquire(sid, owner) {
				known(sid);
				checkHold();
				const l = current(sid);
				if (attached?.localHeld(sid)) throw held(performance.now() + ttlMs);
				if (l) { if (l.owner !== owner) throw held(l.expires); return l.lease; }
				const lease = randomBytes(16).toString("hex");
				leases.set(sid, { lease, owner, expires: performance.now() + ttlMs });
				return lease;
			},
			renew(sid, lease) { known(sid); requireLease(sid, lease).expires = performance.now() + ttlMs; },
			release(sid, lease) { known(sid); if (current(sid)?.lease === lease) leases.delete(sid); },
			append(sid, lease, entries, revision) {
				const s = known(sid), authorize = () => { requireLease(sid, lease); };
				return records.keep(s, entries, authorize, revision);
			},
			erase(sid, entryIds, lease) {
				const s = known(sid);
				const authorize = () => {
					if (lease !== undefined) { requireLease(sid, lease); return; }
					checkHold();
					if (attached?.localHeld(sid)) throw held(performance.now() + ttlMs);
					const l = current(sid);
					if (l) throw held(l.expires);
				};
				authorize();
				return records.erase(s, entryIds, authorize).erased;
			},
		};
	}
	const store = options.store ?? builtInStore(records!);
	const mutate = async <T>(operation: () => T | Promise<T>): Promise<T> => {
		try { return await operation(); }
		catch (error) {
			if (options.store && !(error instanceof HistoryServiceError && Object.hasOwn(historyStorageStatuses, error.code))) throw new UncertainCommit();
			throw error;
		}
	};
	const encodePage = (value: string | JsonObject) => {
		if (typeof value === "string") return value;
		const json = encodeJson(value);
		if (bytes(json) > maxPage) throw unavailable();
		return json;
	};
	function send(res: ServerResponse, status: number, json: string) {
		res.writeHead(status, { "content-type": "application/json", "content-length": bytes(json) });
		res.end(json);
	}
	const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
		try {
			if (!timingSafeEqual(digest(req.headers.authorization ?? ""), token)) {
				res.setHeader("WWW-Authenticate", "Bearer");
				throw new BindingError(401, "unauthorized", "A valid service token is required");
			}
			const target = req.url ?? "/";
			const q = target.indexOf("?");
			const path = q < 0 ? target : target.slice(0, q);
			const rawQuery = q < 0 ? undefined : target.slice(q + 1);
			// Do not use a URL parser that normalizes dot segments or backslashes.
			if (path.split("/").some((s) => [".", ".."].includes(decode(s)))) invalid("Dot path segments are forbidden");
			const route = routes.find(([re, , op]) => (records || (op !== "plans" && op !== "complete")) && re.test(path));
			if (!route) throw new BindingError(404, "not_found", "Unknown path");
			const [re, methods, op] = route;
			if (!(methods as readonly string[]).includes(req.method ?? "")) {
				res.setHeader("Allow", methods.join(", "));
				throw new BindingError(405, "method_not_allowed", "Method is not allowed on this path");
			}
			if (pendingBodies >= 8 && (req.headers["transfer-encoding"] || Number(req.headers["content-length"]) > 0 && Number(req.headers["content-length"]) <= maxBody)) throw unavailable();
			pendingBodies++;
			let raw: Buffer;
			try { raw = await bodyBytes(req); } finally { pendingBodies--; }
			if (req.headers["content-encoding"] !== undefined) throw new BindingError(415, "unsupported_media_type", "Content-Encoding must be omitted");
			if (raw.length && req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new BindingError(415, "unsupported_media_type", "Expected application/json");
			const reading = req.method === "GET";
			const [sid, param] = re.exec(path)!.slice(1).map(decode);
			if ((op === "renew" || op === "release") && !validLease(param)) return invalid("Invalid lease");
			const { after, limit, project } = query(rawQuery, op === "list" ? ["after", "limit", "project"] : (op === "session" || op === "plans") && reading ? ["after", "limit"] : []);
			const b = bodyObject(raw, req.method === "PUT" || op === "acquire" || op === "append" || op === "erase" || op === "complete" || (op === "plans" && !reading));
			records?.check();
			let result: unknown = {};
			switch (op) {
				case "version": result = { binding: HISTORY_BINDING, ttlMs, retention, ...(records && { pendingErasure: 1 }) }; break;
				case "list": {
					const page = await store.list({ project, after, limit });
					return send(res, 200, encodePage(typeof page === "string" ? page : {
						sessions: page.sessions, ...(page.next === undefined ? {} : { next: page.next }),
					}));
				}
				case "session": {
					if (reading) {
						const page = await store.read(sid, { after, limit });
						return send(res, 200, encodePage(typeof page === "string" ? page : {
							session: page.session, entries: page.entries, ...(page.next === undefined ? {} : { next: page.next }),
						}));
					}
					validateMetadata(sid, b);
					await mutate(() => store.create(sid, b));
					break;
				}
				case "acquire": {
					const owner = b.owner;
					if (!id(owner)) return invalid("owner is required");
					const lease = await mutate(() => store.acquire(sid, owner));
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
					const revisions = records && req.headersDistinct["history-revision"];
					if (revisions && (revisions.length !== 1 || !validLease(revisions[0]))) return invalid("Invalid History-Revision header");
					const kept = await mutate(() => store.append(sid, lease, entries as JsonObject[], revisions ? revisions[0] : undefined));
					if (!Number.isSafeInteger(kept) || kept < 0 || kept > entries.length) throw new UncertainCommit();
					result = { kept };
					if (drop > 0) { drop--; res.destroy(); return; }
					break;
				}
				case "plans": {
					if (reading) {
						res.setHeader("Cache-Control", "no-store");
						const json = records!.plans(sid, after, limit);
						return send(res, 200, json);
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
					if (!records!.session(sid, expired)) throw unknownSession();
					result = records!.publish(sid, { revision, intentId, entryIds, copies: [...sets.values()] }, () => requireLease(sid, lease), expired);
					break;
				}
				case "complete": {
					const { lease, entryIds } = b;
					if (!fields(b, "lease", "entryIds") || !validLease(lease) || !distinctIds(entryIds)) return invalid("Invalid erasure completion");
					if (!records!.session(sid, expired)) throw unknownSession();
					records!.complete(sid, param, entryIds, () => requireLease(sid, lease));
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
			send(res, 200, JSON.stringify(result));
		} catch (e) {
			if (e instanceof UncertainCommit || res.headersSent) { res.destroy(); return; }
			if (!req.complete) { res.setHeader("Connection", "close"); req.resume(); }
			const failure = e instanceof BindingError ? e : e instanceof HistoryServiceError && Object.hasOwn(historyStorageStatuses, e.code)
				? new BindingError(historyStorageStatuses[e.code], e.code, e.message,
					e.code === "held" ? Math.max(1, Math.ceil(e.retryAfterMs ?? ttlMs) || ttlMs) : undefined)
				: unavailable();
			send(res, failure.status, JSON.stringify({ error: failure.message, code: failure.code, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) }));
		}
	});
	server.maxConnections = 64;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
		});
	} catch (error) { closeRecords(); throw error; }
	server.once("close", closeRecords);
	const port = (server.address() as AddressInfo).port;
	return { server, port, url: `http://127.0.0.1:${port}` };
}
