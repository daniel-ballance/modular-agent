import { RestoreWitness } from "@modular-agent/harness";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { count, encodeJson, equalJson, nonnegativeNumber, object, parseJson, type Json, type JsonObject } from "./history-json.js";
import { BindingError, UncertainCommit, invalid, unavailable, unknownSession, conflict, id, ids, distinctIds, MAX_LEASE_BYTES, validLease, maxPage } from "./history-binding.js";

const bytes = Buffer.byteLength;
export type CopySet = { sessionId: string; recordId: string; entryIds: string[] };
export type Publication = { revision: string; intentId: string; entryIds: string[]; copies: CopySet[] };
type Plan = { intentId: string; sourceSessionId: string; recordId: string; copies: { entryId: string; complete: boolean }[] };
const planFrame = (revision: string) => `{"revision":${JSON.stringify(revision)},"plans":[`;
const sortIds = (values: string[]) => [...values].sort();
const copyKey = (copies: CopySet[]) => JSON.stringify(copies.map(c => JSON.stringify([c.sessionId, c.recordId, sortIds(c.entryIds)])).sort());
const unknownIntent = () => new BindingError(404, "unknown_intent", "Unknown erasure intent");
const unknownEntry = () => new BindingError(404, "unknown_entry", "Unknown erasure target");


export function historyTombstone(e: JsonObject): JsonObject {
	const kind = typeof e.kind === "string" ? e.kind : null;
	const t: JsonObject = { id: e.id, parentId: e.parentId, kind, erased: true };
	for (const k of ["turnId", "stepId", "toolCallId", "jobId", "inputId", "requestId", "continuesTurnId"]) {
		if (typeof e[k] === "string") t[k] = e[k];
	}
	const d = object(e.data) ? e.data : undefined;

	if (ids(e.sources)) t.sources = e.sources;
	const usage = kind === "response" && object(e.message) ? e.message.usage : kind === "jobEnded" || kind === "turnEnd" ? d?.usage : undefined;
	if (object(usage) && ["input", "output", "cacheRead", "cacheWrite"].every((k) => count(usage[k]) !== undefined) && nonnegativeNumber(usage.cost)) {
		t.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost };
	}
	if (kind === "jobStarted" && id(e.writer) && id(d?.key)) { t.writer = e.writer; t.jobKey = d.key; }
	return t;
}

type Row = { id: string; json: string };
export type Session = Row & { created: number; project: string; changed: number; expired: number };
export const frame = (meta?: string) => meta === undefined ? '{"sessions":[' : `{"session":${meta},"entries":[`;
const tail = (next?: string) => next === undefined ? "]}" : `],"next":${JSON.stringify(next)}}`;
export const fits = (prefix: string, json: string, next: string) => bytes(prefix) + bytes(json) + bytes(tail(next)) <= maxPage;

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

export type HistoryTestControls = {
	commitGate?: { sessionId: string; state: Int32Array<SharedArrayBuffer> };
	wallClock?: BigInt64Array<SharedArrayBuffer>;
	leaseClock?: BigInt64Array<SharedArrayBuffer>;
};

export class Records {
	private db: DatabaseSync;
	private failed = false;
	private witness?: RestoreWitness;
	private disk?: { path: string; dev: bigint; ino: bigint };
	holdUntil = 0;
	ttlEpoch = 0;

	constructor(dir: string | undefined, ttl: number, readonly retention: number | null, private quota: number, private controls?: HistoryTestControls, private failedState?: Int32Array<SharedArrayBuffer>, restoreWitness?: string) {
		if (dir !== undefined) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (readdirSync(dir).some((name) => name.endsWith(".jsonl"))) throw new Error("History directory has no verifiable lease bound; use a fresh directory");
		}
		if (restoreWitness !== undefined) {
			if (dir === undefined) throw unavailable();
			this.witness = new RestoreWitness(dir, restoreWitness);
		}
		const path = dir === undefined ? undefined : join(dir, "history.sqlite");
		const marker = dir === undefined ? undefined : join(dir, "pending-erasure.profile");
		const declared = marker !== undefined && existsSync(marker);
		const existing = path !== undefined && existsSync(path);
		if (declared !== existing) {
			if (this.witness) throw unavailable();
			// Do not create an empty archive in the place of an existing store.
			this.db = new DatabaseSync(":memory:");
			this.fail();
			return;
		}
		if (path && !existing) {
			if (readdirSync(dir!).length) throw new Error("A new history store requires an empty directory");
			this.witness?.reserve();
			closeSync(openSync(path, "wx", 0o600));
		}
		this.db = new DatabaseSync(path ?? ":memory:");
		try {
			if (path !== undefined) {
				const { dev, ino } = statSync(path, { bigint: true });
				this.disk = { path, dev, ino };
			}
			// The retained exclusive lock prevents two service processes from
			// managing independent lease maps over the same store. FULL sync
			// and a rollback journal make a whole batch the durable unit.
			this.db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; BEGIN EXCLUSIVE");
			if (!existing) {
				this.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
					CREATE TABLE sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL, created INTEGER NOT NULL, project TEXT NOT NULL, changed INTEGER NOT NULL, expired INTEGER NOT NULL DEFAULT 0);
					CREATE INDEX session_order ON sessions (created DESC, id);
					CREATE TABLE entries (seq INTEGER PRIMARY KEY, session TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, UNIQUE (session,id));
					CREATE INDEX entry_order ON entries (session,seq);
					CREATE TABLE registry_revision (revision TEXT NOT NULL);
					CREATE TABLE registry_intents (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, operation TEXT UNIQUE NOT NULL, copies TEXT NOT NULL, session_ids TEXT NOT NULL);
					CREATE TABLE registry_plans (session TEXT NOT NULL, intent INTEGER NOT NULL, record TEXT NOT NULL, json TEXT NOT NULL,
						PRIMARY KEY (session,intent), UNIQUE (session,record));
					INSERT INTO settings VALUES ('pending-erasure-profile',1);`);
				this.db.prepare("INSERT INTO registry_revision VALUES (?)").run(randomBytes(32).toString("hex"));
			} else {
				const profile = this.db.prepare("SELECT value FROM settings WHERE key='pending-erasure-profile'").get();
				const column = this.db.prepare("SELECT type, [notnull] FROM pragma_table_info('registry_intents') WHERE name='session_ids'").get();
				if (profile?.value !== 1 || column?.type !== "TEXT" || column.notnull !== 1) throw unavailable();
				this.revision();
				this.db.prepare("SELECT seq,id,operation,copies,session_ids FROM registry_intents LIMIT 0");
				this.db.prepare("SELECT session,intent,record,json FROM registry_plans LIMIT 0");
			}
			const enrolled = this.db.prepare("SELECT value FROM settings WHERE key='restore-witness'").get();
			if (existing) {
				if (Boolean(enrolled) !== Boolean(this.witness)) throw unavailable();
				this.witness?.check(this.revision());
			} else if (this.witness) {
				this.db.exec("INSERT INTO settings VALUES ('restore-witness',1)");
				this.witness.publish(this.revision());
			}
			const prior = this.db.prepare("SELECT value FROM settings WHERE key='ttl-bound'").get()?.value;
			if (existing && prior === undefined) throw new Error("Stored TTL bound is missing");
			if (prior !== undefined && (typeof prior !== "number" || !Number.isSafeInteger(prior) || prior < 0)) throw new Error("Stored TTL bound is invalid");
			const bound = Math.max(prior ?? 0, ttl);
			this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('ttl-bound',?)").run(bound);
			if (ttl > 0) this.bumpTtlEpoch();
			else this.ttlEpoch = Number(this.db.prepare("SELECT value FROM settings WHERE key='ttl-epoch'").get()?.value ?? 0);
			this.db.exec("COMMIT");
			if (marker !== undefined && !declared) {
				// The marker detects an absent database, not two matching, stale backups.
				writeFileSync(marker, "1\n", { mode: 0o600, flag: "wx", flush: true });
				const directory = openSync(dir!, "r");
				try { fsyncSync(directory); } finally { closeSync(directory); }
			}
			this.holdUntil = prior === undefined ? 0 : performance.now() + bound;
		} catch (error) { this.db.close(); throw error; }
	}
	close() { this.db.close(); }
	now() { return this.controls?.wallClock ? Number(Atomics.load(this.controls.wallClock, 0)) : Date.now(); }
	private fail() {
		this.failed = true;
		if (this.failedState) Atomics.store(this.failedState, 0, 1);
	}
	private bumpTtlEpoch() {
		this.db.exec("INSERT INTO settings VALUES ('ttl-epoch',1) ON CONFLICT(key) DO UPDATE SET value=value+1");
		this.ttlEpoch = Number(this.db.prepare("SELECT value FROM settings WHERE key='ttl-epoch'").get()!.value);
	}
	bindTtl(ttl: number) {
		if (this.failed) return;
		this.commit(() => {
			this.db.prepare("UPDATE settings SET value=MAX(value,?) WHERE key='ttl-bound'").run(ttl);
			this.bumpTtlEpoch();
		});
	}
	empty() { this.check(); return !this.db.prepare("SELECT 1 FROM sessions LIMIT 1").get(); }
	check() {
		if (this.failed) throw unavailable();
		if (this.witness) { this.witness.check(this.revision()); }
	}
	private commit<T>(operation: () => T, authorize?: () => void): T {
		this.check();
		this.db.exec("BEGIN IMMEDIATE");
		let committing = false;
		try {
			const prior = this.witness && this.revision();
			const result = operation();
			authorize?.();
			committing = true;
			if (this.witness) {
				const next = this.revision();
				if (next !== prior) this.witness.publish(next);
			}
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (committing) this.fail();
			try { this.db.exec("ROLLBACK"); } catch { this.fail(); }
			if (this.failed) throw new UncertainCommit();
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
			this.db.prepare("INSERT INTO sessions (id,json,created,project,changed) VALUES (?,?,?,?,?)").run(sid, json, count(initial.created)!, initial.project as string, this.now());
			this.advanceRevision();
		});
	}
	list(project: string | undefined, after: string | undefined, limit: number, expires: (s: Session) => boolean) {
		const visible = "NOT expired AND EXISTS (SELECT 1 FROM entries WHERE entries.session=sessions.id)";
		const which = project === undefined ? visible : visible + " AND project=?";
		const args = project === undefined ? [] : [project];
		if (this.retention !== null) {
			const old = this.db.prepare(`SELECT id FROM sessions WHERE NOT expired AND changed<=?`).all(this.now() - this.retention) as { id: string }[];
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
			if (kept) this.changed(s.id);
			const gate = this.controls?.commitGate;
			if (gate?.sessionId === s.id && Atomics.compareExchange(gate.state, 0, 0, 1) === 0) {
				Atomics.notify(gate.state, 0);
				if (Atomics.wait(gate.state, 0, 1, 20_000) === "timed-out") throw new Error("History commit gate was not released");
			}
			return kept;
		}, authorize);
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
			if (changed) this.changed(s.id);
			return { erased };
		}, authorize);
	}
	private changed(sid: string) {
		this.db.prepare("UPDATE sessions SET changed=? WHERE id=?").run(this.now(), sid);
		this.advanceRevision();
	}
	private revision() {
		if (this.disk) {
			const where = statSync(this.disk.path, { bigint: true, throwIfNoEntry: false });
			if (where?.dev !== this.disk.dev || where.ino !== this.disk.ino) throw unavailable();
		}
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
	pendingIndex(after: string | undefined, limit: number) {
		const revision = this.revision();
		const rows = this.db.prepare(`WITH pending AS (
			SELECT session, intent FROM registry_plans WHERE EXISTS (
				SELECT 1 FROM json_each(json, '$.copies') WHERE json_extract(value, '$.complete') = 0
			)
		) SELECT session AS id, json_object('sessionId', session, 'intentIds', json_group_array(registry_intents.id)) AS json
			FROM pending JOIN registry_intents ON seq=intent WHERE session>? GROUP BY session ORDER BY session LIMIT ?`);
		if (after !== undefined && !this.db.prepare(`SELECT 1 FROM registry_plans WHERE session=? AND EXISTS (
			SELECT 1 FROM json_each(json, '$.copies') WHERE json_extract(value, '$.complete') = 0
		)`).get(after)) throw unknownSession();
		return page(`{"revision":${JSON.stringify(revision)},"sessions":[`, rows.iterate(after ?? "", limit + 1) as Iterable<Row>, limit);
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
			const prior = this.db.prepare("SELECT id,session_ids FROM registry_intents WHERE operation=?").get(operation);
			if (prior) {
				const sessionIds = JSON.parse(prior.session_ids as string) as Json;
				if (!distinctIds(sessionIds) || !sessionIds.includes(sid)) throw unavailable();
				return { intentId: prior.id, sessionIds };
			}
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
			const sessionIds = copies.map(copy => copy.sessionId);
			const { lastInsertRowid } = this.db.prepare("INSERT INTO registry_intents (id,operation,copies,session_ids) VALUES (?,?,?,?)")
				.run(intentId, operation, key, JSON.stringify(sessionIds));
			const insert = this.db.prepare("INSERT INTO registry_plans VALUES (?,?,?,?)");
			copies.forEach((copy, i) => insert.run(copy.sessionId, lastInsertRowid, copy.recordId, plans[i]));
			this.advanceRevision();
			return { intentId, sessionIds };
		}, authorize);
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
			if (entryIds.every(id => copies.get(id)!.complete)) return;
			for (const id of entryIds) copies.get(id)!.complete = true;
			this.db.prepare("UPDATE registry_plans SET json=? WHERE session=? AND intent=?").run(JSON.stringify(plan), sid, row.intent!);
			this.advanceRevision();
		}, authorize);
	}
}


export function validateMetadata(sid: string, initial: JsonObject) {
	if (Object.hasOwn(initial, "id") || typeof initial.project !== "string" || count(initial.created) === undefined ||
		(Object.hasOwn(initial, "parentSessionId") && !id(initial.parentSessionId)) ||
		(Object.hasOwn(initial, "forkedFrom") && (!object(initial.forkedFrom) || !id(initial.forkedFrom.sessionId) || !id(initial.forkedFrom.entryId)))) invalid("Invalid session metadata");
	const json = encodeJson({ ...initial, id: sid });
	if (!fits(frame(), json, sid) || bytes(frame(json)) + 2 > maxPage) throw new BindingError(413, "request_too_large", "Metadata cannot fit a read page");
}
