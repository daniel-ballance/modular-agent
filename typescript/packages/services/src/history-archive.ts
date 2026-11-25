import { filePendingErasure, memoryPendingErasure, type HistoryStore, type PendingErasure } from "@modular-agent/harness";
import { BindingError, unavailable } from "./history-binding.js";
import { RenewalLeases } from "./history-leases.js";
import { Records, type HistoryTestControls } from "./history-records.js";
import { HistoryThread } from "./history-thread.js";

const archiveCleanup = new FinalizationRegistry<HistoryThread>(thread => { void thread.terminate(); });

export class HistoryArchive {
	private thread?: HistoryThread;
	private registry?: PendingErasure;
	private nextOwner = 0;
	private local = new Map<string, number>();
	private remote?: RenewalLeases;
	private bootUnavailable = false;
	constructor(readonly dir?: string, private pendingErasureDir = dir) {}
	get persistent() { return this.dir !== undefined; }

	private storage(controls?: HistoryTestControls) {
		if (this.thread) return this.thread;
		let exclusion: { epoch: number; until: number } | undefined;
		if (this.dir !== undefined) {
			// Establish the archive before the local registry can create files beside it.
			const db = new Records(this.dir, 0, null, 100_000);
			try { db.check(); } catch { this.bootUnavailable = true; }
			finally { db.close(); }
			exclusion = { epoch: db.ttlEpoch, until: db.holdUntil };
		}
		this.thread = new HistoryThread({ archive: true, dir: this.dir, exclusion, controls });
		archiveCleanup.register(this, this.thread);
		return this.thread;
	}

	async attach(leases: RenewalLeases, ttl: number, controls?: HistoryTestControls) {
		if (this.remote) throw new Error("This archive is already being served");
		const thread = this.storage(controls);
		this.remote = leases;
		try { await thread.run({ kind: "attach", ttl }); }
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
		return {
			supports: { portableSessions: this.persistent, persistent: this.persistent, erasure: true },
			pendingErasure: this.registry ??= this.pendingErasureDir ? filePendingErasure(this.pendingErasureDir) : memoryPendingErasure(),
			create: meta => thread.run({ kind: "local", owner, call: ["create", meta] }),
			openForWriting: async id => {
				await thread.run({ kind: "local", owner, call: ["openForWriting", id] });
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
			append: (id, batch) => thread.run({ kind: "local", owner, call: ["append", id, batch] }),
			load: id => thread.run({ kind: "local", owner, call: ["load", id] }),
			list: filter => thread.run({ kind: "local", owner, call: ["list", filter] }),
			erase: (id, targets) => thread.run({ kind: "local", owner, call: ["erase", id, targets] }),
		};
	}
}
