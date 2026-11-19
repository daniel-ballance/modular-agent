import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { count, encodeJson, equalJson, nonnegativeNumber, object, parseJson, type Json, type JsonObject } from "./history-json.js";

export const HISTORY_BINDING = "modular-agent-history/1";
const maxBody = 64 * 1024 * 1024;
const maxPage = 4 * 1024 * 1024;
const bytes = Buffer.byteLength;
const decodeBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export const MAX_LEASE_BYTES = 128;
export const validLease = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= MAX_LEASE_BYTES && !/[^A-Za-z0-9_-]/.test(v);
const ids = (v: Json | undefined): v is string[] => Array.isArray(v) && v.every(id);

class BindingError extends Error {
	constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs?: number) { super(message); }
}
class UncertainCommit extends Error {}
const invalid = (message: string): never => { throw new BindingError(400, "invalid_request", message); };
const unavailable = () => new BindingError(503, "unavailable", "History storage is temporarily unavailable");
const unknownSession = () => new BindingError(404, "unknown_session", "Unknown session");
const conflict = () => new BindingError(409, "conflict", "The ID is reserved with different content or has expired");
const held = (until: number) => new BindingError(409, "held", "Session is held by another owner or temporarily excluded", Math.max(1, Math.ceil(until - performance.now())));

function tombstone(e: JsonObject): JsonObject {
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
	readonly holdUntil: number;

	constructor(dir: string, ttl: number, readonly retention: number | null, private quota: number) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (readdirSync(dir).some((name) => name.endsWith(".jsonl"))) throw new Error("Legacy history directory has no verifiable lease bound; use a fresh directory");
		this.db = new DatabaseSync(join(dir, "history.sqlite"));
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
			const prior = this.db.prepare("SELECT value FROM settings WHERE key='ttl-bound'").get()?.value;
			if (prior === undefined && this.db.prepare("SELECT 1 FROM sessions LIMIT 1").get()) throw new Error("Stored TTL bound is missing");
			if (prior !== undefined && (typeof prior !== "number" || !Number.isSafeInteger(prior) || prior <= 0)) throw new Error("Stored TTL bound is invalid");
			const bound = Math.max(prior ?? 0, ttl);
			this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('ttl-bound',?)").run(bound);
			this.db.exec("COMMIT");
			this.holdUntil = prior === undefined ? 0 : performance.now() + bound;
		} catch (error) { this.db.close(); throw error; }
	}
	close() { this.db.close(); }
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
		});
	}
	put(sid: string, initial: JsonObject, expires: (s: Session) => boolean) {
		if (Object.hasOwn(initial, "id") || typeof initial.project !== "string" || count(initial.created) === undefined ||
			(Object.hasOwn(initial, "parentSessionId") && !id(initial.parentSessionId)) ||
			(Object.hasOwn(initial, "forkedFrom") && (!object(initial.forkedFrom) || !id(initial.forkedFrom.sessionId) || !id(initial.forkedFrom.entryId)))) invalid("Invalid session metadata");
		const meta = { ...initial, id: sid };
		const json = encodeJson(meta);
		if (!fits(frame(), json, sid) || bytes(frame(json)) + 2 > maxPage) throw new BindingError(413, "request_too_large", "Metadata cannot fit a read page");
		const row = this.session(sid, expires);
		if (row) { if (!equalJson(row.json, meta)) throw conflict(); return; }
		if (this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sid)) throw conflict();
		if (this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n as number >= this.quota) throw unavailable();
		this.commit(() => this.db.prepare("INSERT INTO sessions (id,json,created,project,changed) VALUES (?,?,?,?,?)").run(sid, json, count(initial.created)!, initial.project as string, Date.now()));
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
	keep(s: Session, batch: JsonObject[], authorize: () => void) {
		const prefix = frame(s.json);
		let kept = 0;
		const find = this.db.prepare("SELECT json FROM entries WHERE session=? AND id=?");
		const insert = this.db.prepare("INSERT INTO entries (session,id,json) VALUES (?,?,?)");
		return this.commit(() => {
			for (const e of batch) {
				const eid = e.id as string;
				const known = find.get(s.id, eid)?.json as string | undefined;
				if (known !== undefined) { if (!equalJson(known, e)) throw conflict(); continue; }
				const json = encodeJson(e);
				if (!fits(prefix, json, eid) || !fits(prefix, encodeJson(tombstone(e)), eid)) throw new BindingError(413, "entry_too_large", "Entry cannot fit a read page");
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
				replace.run(encodeJson(tombstone(entry)), s.id, eid);
				changed = true;
			}
			authorize();
			if (changed) this.changed(s.id);
			return { erased };
		});
	}
	private changed(sid: string) { this.db.prepare("UPDATE sessions SET changed=? WHERE id=?").run(Date.now(), sid); }
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

export interface HistoryServiceOptions {
	dir: string; token: string; port?: number; leaseMs?: number; retention?: number | null;
	/** Permanent ID reservations count toward this operator-supplied limit. */
	maxSessions?: number;
	/** Fault injection for the history client tests. */
	dropAppendResponses?: number;
}

/** A single loopback HTTP listener. The operator must trust every local account,
 * provision a random bearer token, and keep this directory on durable local storage. */
export async function historyService(options: HistoryServiceOptions) {
	const ttlMs = options.leaseMs ?? 15_000, retention = options.retention ?? null, quota = options.maxSessions ?? 100_000;
	for (const n of [ttlMs, quota, ...(retention === null ? [] : [retention])]) if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid history service limit");
	if (!/^[A-Za-z0-9._~+/\-]+=*$/.test(options.token)) throw new Error("Invalid history bearer token configuration");
	const token = digest(`Bearer ${options.token}`);
	const records = new Records(options.dir, ttlMs, retention, quota);
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
	const expired = (s: Session) => retention !== null && !current(s.id) && Date.now() - s.changed >= retention;
	const known = (sid: string) => records.session(sid, expired) ?? (() => { throw unknownSession(); })();
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
			const route = routes.find(([re]) => re.test(path));
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
			const [sid, leaseParam] = re.exec(path)!.slice(1).map(decode);
			if (leaseParam !== undefined && !validLease(leaseParam)) return invalid("Invalid lease");
			const { after, limit, project } = query(rawQuery, op === "list" ? ["after", "limit", "project"] : op === "session" && reading ? ["after", "limit"] : []);
			const b = bodyObject(raw, req.method === "PUT" || op === "acquire" || op === "append" || op === "erase");
			records.check();
			let result: unknown = {};
			switch (op) {
				case "version": result = { binding: HISTORY_BINDING, ttlMs, retention }; break;
				case "list": return send(res, 200, records.list(project, after, limit, expired));
				case "session":
					if (reading) return send(res, 200, records.read(known(sid), after, limit));
					records.put(sid, b, expired);
					break;
				case "acquire": {
					if (!id(b.owner)) return invalid("owner is required");
					known(sid);
					if (records.holdUntil > performance.now()) throw held(records.holdUntil);
					const l = current(sid);
					if (l && l.owner !== b.owner) throw held(l.expires);
					const lease = l?.lease ?? randomBytes(16).toString("hex");
					if (!l) leases.set(sid, { lease, owner: b.owner, expires: performance.now() + ttlMs });
					result = { lease, ttlMs };
					break;
				}
				case "renew":
					known(sid);
					requireLease(sid, leaseParam).expires = performance.now() + ttlMs;
					result = { ttlMs };
					break;
				case "release":
					known(sid);
					if (current(sid)?.lease === leaseParam) leases.delete(sid);
					break;
				case "append": {
					if (!validLease(b.lease) || !Array.isArray(b.entries) || !b.entries.every((e) => object(e) && id(e.id) && (e.parentId === null || id(e.parentId)) && e.erased !== true)) return invalid("Invalid lease or entries");
					const s = known(sid), authorize = () => { requireLease(sid, b.lease); };
					authorize();
					result = { kept: records.keep(s, b.entries as JsonObject[], authorize) };
					if (drop > 0) { drop--; res.destroy(); return; }
					break;
				}
				case "erase": {
					if (!ids(b.entryIds) || (Object.hasOwn(b, "lease") && !validLease(b.lease))) return invalid("Invalid entry IDs or lease");
					const s = known(sid);
					const authorize = () => {
						if (b.lease !== undefined) { requireLease(sid, b.lease); return; }
						if (records.holdUntil > performance.now()) throw held(records.holdUntil);
						const l = current(sid);
						if (l) throw held(l.expires);
					};
					authorize();
					result = records.erase(s, b.entryIds, authorize);
					break;
				}
			}
			send(res, 200, JSON.stringify(result));
		} catch (e) {
			if (e instanceof UncertainCommit || res.headersSent) { res.destroy(); return; }
			if (!req.complete) { res.setHeader("Connection", "close"); req.resume(); }
			const failure = e instanceof BindingError ? e : unavailable();
			send(res, failure.status, JSON.stringify({ error: failure.message, code: failure.code, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) }));
		}
	});
	server.maxConnections = 64;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
		});
	} catch (error) { records.close(); throw error; }
	server.once("close", () => records.close());
	const port = (server.address() as AddressInfo).port;
	return { server, port, url: `http://127.0.0.1:${port}` };
}
