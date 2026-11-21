import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ErasureCopy { sessionId: string; id: string; erased: boolean }
export interface ErasureIntent { id: string; sessionId: string; actorId: string; targets: string[]; copies: ErasureCopy[] }

export interface PendingErasure {
	/** Read current state, including completed marks needed to fence stale readers. */
	intents(): ErasureIntent[];
	/** Serialize a publication with lineage writes to this history namespace. */
	exclusive<T>(work: () => Promise<T>): Promise<T>;
	/** Insert or advance an intent from inside exclusive(). */
	keep(intent: ErasureIntent): void;
}

const unavailable = (cause: unknown) => Object.assign(new Error("Pending erasure state is unavailable", { cause }), { code: "unavailable" });

export function memoryPendingErasure(): PendingErasure {
	const intents = new Map<string, ErasureIntent>();
	let tail = Promise.resolve();
	return {
		intents: () => structuredClone([...intents.values()]),
		exclusive<T>(work: () => Promise<T>) {
			const run = tail.then(work);
			tail = run.then(() => {}, () => {});
			return run;
		},
		keep: intent => { intents.set(intent.id, structuredClone(intent)); },
	};
}

const fileRegistries = new Map<string, PendingErasure>();

/** The registry is beside the history, not a per-agent cache. SQLite fences publications across processes. */
export function filePendingErasure(dir: string): PendingErasure {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(realpathSync(dir), "pending-erasure.sqlite");
	const existing = fileRegistries.get(path);
	if (existing) return existing;
	const init = new DatabaseSync(path);
	try {
		init.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS erasure (id TEXT PRIMARY KEY, intent TEXT NOT NULL)");
	} finally { init.close(); }
	const current = new AsyncLocalStorage<{ db: DatabaseSync; active: boolean }>();
	let tail = Promise.resolve();
	const read = (db: DatabaseSync) => db.prepare("SELECT intent FROM erasure ORDER BY rowid").all().map(row => JSON.parse(String(row.intent)) as ErasureIntent);
	const registry: PendingErasure = {
		intents() {
			try {
				const scope = current.getStore();
				if (scope?.active) return read(scope.db);
				const reader = new DatabaseSync(path, { readOnly: true });
				try { return read(reader); } finally { reader.close(); }
			} catch (error) { throw unavailable(error); }
		},
		exclusive<T>(work: () => Promise<T>) {
			const run = tail.then(async () => {
				const db = new DatabaseSync(path);
				const scope = { db, active: true };
				try {
					try { db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE"); }
					catch (error) { throw unavailable(error); }
					const result = await current.run(scope, work);
					try { db.exec("COMMIT"); } catch (error) { throw unavailable(error); }
					return result;
				} finally { scope.active = false; db.close(); }
			});
			tail = run.then(() => {}, () => {});
			return run;
		},
		keep(intent) {
			const scope = current.getStore();
			if (!scope?.active) throw unavailable(new Error("No erasure transaction"));
			scope.db.prepare("INSERT INTO erasure VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET intent = excluded.intent").run(intent.id, JSON.stringify(intent));
		},
	};
	fileRegistries.set(path, registry);
	return registry;
}
