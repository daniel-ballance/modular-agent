import type { HistoryEntry, HistoryStore, StoredSession } from "@modular-agent/harness";
import { BindingError, held, unavailable } from "./history-binding.js";
import { parseJson, type JsonObject } from "./history-json.js";
import { Records, validateMetadata, type HistoryTestControls } from "./history-records.js";

export class ArchiveRecords {
	private records?: Records;

	private local = new Map<string, number>();
	private remote?: { leased(id: string): boolean; ttl: number };
	constructor(readonly dir: string | undefined, private exclusion?: { epoch: number; until: number },
		private controls?: HistoryTestControls, private failedState?: Int32Array<SharedArrayBuffer>, private restoreWitness?: string) {}
	get persistent() { return this.dir !== undefined; }

	private db() {
		if (this.failedState && Atomics.load(this.failedState, 0)) throw unavailable();
		if (!this.records) {
			this.records = new Records(this.dir, 0, null, 100_000, this.controls, this.failedState, this.restoreWitness);
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
		if (this.restoreWitness) records.check();
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
	store(owner: number): Omit<HistoryStore, "pendingErasure"> {
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
			writerActive: id => this.local.has(id) || this.remote?.leased(id) === true,
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
