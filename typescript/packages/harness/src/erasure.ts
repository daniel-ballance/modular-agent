import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RestoreWitness } from "./restore-witness.js";

/** History HTTP's shared revision and per-session plans, not Provider state. */
export interface ErasurePlan {
	intentId: string; sourceSessionId: string; recordId: string;
	copies: { entryId: string; complete: boolean }[];
}
export interface ErasurePublication {
	revision: string; intentId: string; entryIds: string[];
	copies: { sessionId: string; recordId: string; entryIds: string[] }[];
}
export interface HistoryErasureRegistry {
	read(id: string): Promise<{ revision: string; plans: ErasurePlan[] }>;
	publish(id: string, intent: ErasurePublication): Promise<{ intentId: string; sessionIds: string[] }>;
	complete(id: string, intentId: string, entryIds: string[]): Promise<void>;
}
export interface ErasureCopy { sessionId: string; id: string; erased: boolean }
export interface ProviderErasureCopy { sessionId: string; provider: string; confirmed: boolean }
export interface ErasureIntent {
	id: string; sessionId: string; actorId: string; targets: string[]; copies: ErasureCopy[];
	providers?: ProviderErasureCopy[];
}

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

const BUSY_TIMEOUT_MS = 5000;
type FileRegistry = PendingErasure & { check(): void };
const fileRegistries = new Map<string, { registry: FileRegistry; witness?: string }>();

/** The registry is beside the history, not a per-agent cache. SQLite fences publications across processes. */
export function filePendingErasure(dir: string, options: { requireExisting?: boolean; restoreWitness?: string; root?: string } = {}): FileRegistry {
	const { requireExisting, restoreWitness, root = dir } = options;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(realpathSync(dir), "pending-erasure.sqlite");
	const witness = restoreWitness === undefined ? undefined : new RestoreWitness(root, restoreWitness);
	const cached = fileRegistries.get(path);
	if (cached) {
		if (cached.witness !== restoreWitness) throw unavailable(new Error("Registry witness configuration changed"));
		cached.registry.check();
		return cached.registry;
	}
	const stamp = (db: DatabaseSync) => String(db.prepare("SELECT stamp FROM restore_witness WHERE id=1").get()?.stamp ?? "");
	const verify = (db: DatabaseSync) => {
		db.prepare("SELECT id,intent FROM erasure LIMIT 0");
		const enrolled = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='restore_witness'").get();
		if (Boolean(enrolled) !== Boolean(witness)) throw unavailable(new Error("Registry witness configuration changed"));
		witness?.check(stamp(db));
	};
	if (!existsSync(path)) {
		if (requireExisting) throw unavailable(new Error("Missing registry for existing history"));
		witness?.reserve();
		closeSync(openSync(path, "wx", 0o600));
		const init = new DatabaseSync(path);
		try {
			init.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE erasure (id TEXT PRIMARY KEY, intent TEXT NOT NULL)");
			if (witness) {
				const first = randomUUID();
				init.exec("CREATE TABLE restore_witness (id INTEGER PRIMARY KEY, stamp TEXT NOT NULL)");
				init.prepare("INSERT INTO restore_witness VALUES (1, ?)").run(first);
				witness.publish(first);
			}
			init.exec("COMMIT");
		} finally { init.close(); }
	}
	const current = new AsyncLocalStorage<{ db: DatabaseSync; active: boolean; changed: boolean }>();
	let tail = Promise.resolve();
	const read = (db: DatabaseSync) => db.prepare("SELECT intent FROM erasure ORDER BY rowid").all().map(row => JSON.parse(String(row.intent)) as ErasureIntent);
	const withReader = <T>(work: (db: DatabaseSync) => T): T => {
		try {
			const scope = current.getStore();
			if (scope?.active) return work(scope.db);
			const reader = new DatabaseSync(path, { readOnly: true });
			try { reader.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`); verify(reader); return work(reader); }
			finally { reader.close(); }
		} catch (error) { throw unavailable(error); }
	};
	const registry: FileRegistry = {
		check: () => withReader(() => {}),
		intents: () => withReader(read),
		exclusive<T>(work: () => Promise<T>) {
			const run = tail.then(async () => {
				if (!existsSync(path)) throw unavailable(new Error("Missing registry"));
				const db = new DatabaseSync(path);
				const scope = { db, active: true, changed: false };
				try {
					try { db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA synchronous = FULL; BEGIN IMMEDIATE`); verify(db); }
					catch (error) { throw unavailable(error); }
					const result = await current.run(scope, work);
					try {
						if (witness && scope.changed) {
							const next = randomUUID();
							db.prepare("UPDATE restore_witness SET stamp=? WHERE id=1").run(next);
							witness.publish(next);
						}
						db.exec("COMMIT");
					} catch (error) { throw unavailable(error); }
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
			scope.changed = true;
		},
	};
	registry.check();
	fileRegistries.set(path, { registry, witness: restoreWitness });
	return registry;
}
