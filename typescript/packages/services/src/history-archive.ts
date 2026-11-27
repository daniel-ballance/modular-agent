import { filePendingErasure, memoryPendingErasure, type HistoryStore } from "@modular-agent/harness";
import { BindingError, unavailable } from "./history-binding.js";
import { RenewalLeases } from "./history-leases.js";
import { Records, type HistoryTestControls } from "./history-records.js";
import { HistoryThread } from "./history-thread.js";

const archiveCleanup = new FinalizationRegistry<HistoryThread>(thread => { void thread.terminate(); });

export class HistoryArchive {
	private thread?: HistoryThread;
	private registry?: ReturnType<typeof filePendingErasure>;
	private nextOwner = 0;
	private memoryRegistry = memoryPendingErasure();
	private local = new Map<string, number>();
	private remote?: RenewalLeases;
	private bootUnavailable = false;
	private wasEmpty = false;
	constructor(readonly dir?: string, private pendingErasureDir = dir, private restoreWitness?: string) {}
	get persistent() { return this.dir !== undefined; }

	private storage(controls?: HistoryTestControls) {
		if (this.thread) return this.thread;
		let exclusion: { epoch: number; until: number } | undefined;
		if (this.dir !== undefined) {
			// Establish the archive before the local registry can create files beside it.
			const db = new Records(this.dir, 0, null, 100_000, undefined, undefined, this.restoreWitness);
			try { this.wasEmpty = db.empty(); } catch { this.bootUnavailable = true; }
			finally { db.close(); }
			exclusion = { epoch: db.ttlEpoch, until: db.holdUntil };
		}
		this.thread = new HistoryThread({ archive: true, dir: this.dir, exclusion, controls, restoreWitness: this.restoreWitness });
		archiveCleanup.register(this, this.thread);
		return this.thread;
	}

	async attach(leases: RenewalLeases, ttl: number, controls?: HistoryTestControls) {
		if (this.remote) throw new Error("This archive is already being served");
		const thread = this.storage(controls);
		this.remote = leases;
		try { await thread.run({ kind: "attach", ttl }); this.wasEmpty = false; }
		catch (error) { this.remote = undefined; throw error; }
		return { thread, detach: async () => {
			try { await thread.run({ kind: "detach" }); }
			finally { this.remote = undefined; }
		} };
	}

	store(): HistoryStore {
		const thread = this.storage();
		if (this.bootUnavailable || !thread.available) throw unavailable();
		const owner = ++this.nextOwner;
		const registry = this.pendingErasureDir === undefined ? undefined : this.registry ??= filePendingErasure(this.pendingErasureDir, {
			requireExisting: !this.wasEmpty, restoreWitness: this.restoreWitness && `${this.restoreWitness}.registry`, root: this.dir,
		});
		registry?.check();
		const run = thread.run.bind(thread);
		const checked: typeof thread.run = job => { if (job.kind === "local" && job.call[0] !== "close") registry?.check(); return run(job); };
		return {
			supports: { portableSessions: this.persistent, persistent: this.persistent, erasure: true },
			pendingErasure: registry ?? this.memoryRegistry,
			create: meta => checked({ kind: "local", owner, call: ["create", meta] }),
			openForWriting: async id => {
				await checked({ kind: "local", owner, call: ["openForWriting", id] });
				this.local.set(id, owner);
			},
			writerActive: id => thread.available && (this.local.has(id) || this.remote?.current(id) !== undefined),
			checkWriter: id => {
				if (!thread.available || this.local.get(id) !== owner) throw new BindingError(409, "lost", "No history writer");
			},
			close: async id => {
				if (this.local.get(id) === owner) this.local.delete(id);
				await thread.run({ kind: "local", owner, call: ["close", id] });
				if (this.local.get(id) === owner) this.local.delete(id);
			},
			append: (id, batch) => checked({ kind: "local", owner, call: ["append", id, batch] }),
			load: id => checked({ kind: "local", owner, call: ["load", id] }),
			list: filter => checked({ kind: "local", owner, call: ["list", filter] }),
			erase: (id, targets) => checked({ kind: "local", owner, call: ["erase", id, targets] }),
		};
	}
}
