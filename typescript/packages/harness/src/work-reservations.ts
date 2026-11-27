import type { SessionLifecycle } from "./session-lifecycle.js";
import { Jobs } from "./jobs.js";
import { failure } from "./failure.js";
import { Reservations, resourceBytes, retainedHistoryBytes } from "./reservations.js";
import type { QueuedInput, Session } from "./session.js";
import { type HistoryStore, isToolCall } from "./types.js";

interface WorkReservationsOperations {
	use<T>(capability: string): T | undefined;
	lifecycle(): Pick<SessionLifecycle, "replayStored">;
	reservations(): Reservations;
	jobWork(): Pick<Jobs, "runningJobs">;
}

function retainedTenant({ meta, entries }: Awaited<ReturnType<HistoryStore["load"]>>): string | undefined {
	const marker = entries.findLast(entry => entry?.kind === "tenant" && !entry.erased &&
		!(meta.forkedFrom && entry.sources?.length) && typeof (entry.data as { tenant?: unknown } | undefined)?.tenant === "string");
	return (marker?.data as { tenant: string } | undefined)?.tenant ??
		("tenant" in meta && typeof meta.tenant === "string" ? meta.tenant : undefined);
}

export class WorkReservations {
	constructor(private readonly operations: WorkReservationsOperations) {}

	private reservationScan?: Promise<void>;

	rebuildReservations(): Promise<void> {
		return this.reservationScan ??= (async () => {
			const store = this.operations.use<HistoryStore>("history-store");
			if (!store) return;
			for (const { id } of await store.list()) {
				const loaded = await store.load(id);
				let s: Session | undefined;
				try {
					s = this.operations.lifecycle().replayStored(loaded);
				} catch {
					// An invalid session still occupies storage, but its work cannot be recovered.
				}
				// A pending tombstone can hide content from the in-memory view before
				// the backend has actually reclaimed the encoded bytes.
				this.operations.reservations().retain(s ?? { id, tenant: retainedTenant(loaded) }, retainedHistoryBytes(loaded), true);
				if (!s) continue;
				const entries = s.order.map(id => s.entries.get(id)!);
				for (const q of s.admissions.values()) this.reserveInput(s, q, true);
				for (const { job } of this.operations.jobWork().runningJobs(s)) this.reserveJob(s, job.id, true);
				const own = entries.filter(e => !s.copied.has(e.id));
				const results = new Set(own.filter(e => e.kind === "toolResult").map(e => e.toolCallId));
				const ended = new Set(own.filter(e => e.kind === "turnEnd").map(e => e.turnId));
				const answered = new Set(own.filter(e => e.kind === "response").map(e => e.stepId));
				const closed = new Set(own.filter(e => e.kind === "inputAnswer").map(e => e.requestId));
				const unit = this.operations.reservations().limits.settlementBytes;
				for (const e of own) {
					if (e.kind === "inputRequest" && !e.erased && !closed.has(e.requestId)) {
						this.operations.reservations().reserve(s, `question:${e.requestId}`, { storageBytes: 3 * unit }, true);
					}
					if (e.kind === "turnStart" && e.turnId && !ended.has(e.turnId)) this.operations.reservations().reserve(s, `turn:${e.turnId}`, { storageBytes: 2 * unit }, true);
					if (e.kind === "modelRequest" && e.stepId && !answered.has(e.stepId) && !ended.has(e.turnId)) {
						this.operations.reservations().reserve(s, `model:${e.stepId}`, { calls: 1, storageBytes: 2 * unit }, true);
					}
				}
				for (const entry of entries) {
					if (s.copied.has(entry.id)) continue;
					if (entry.kind === "response" && entry.message?.role === "assistant") {
						for (const part of entry.message.content) if (isToolCall(part) && !results.has(part.id)) this.reserveCall(s, part.id, true);
					}
					if ((entry.kind === "modular-agent.nestedCall" || entry.kind === "toolStarted") && entry.toolCallId && !results.has(entry.toolCallId)) {
						this.reserveCall(s, entry.toolCallId, true);
					}
				}
			}
		})();
	}

	reserveInput(s: Session, q: QueuedInput, rebuilding = false, startsNow = false) {
		const size = resourceBytes(q);
		const unit = this.operations.reservations().limits.settlementBytes;
		if (!rebuilding && size + 2048 > this.operations.reservations().limits.entryBytes ||
			!this.operations.reservations().reserve(s, `input:${q.id}`, { inputs: startsNow ? 0 : 1, bufferedBytes: size, storageBytes: 3 * size + 4 * unit }, rebuilding)) {
			throw failure("busy", "No capacity for input");
		}
	}

	reserveCall(s: Session, id: string, rebuilding = false) {
		return this.operations.reservations().reserve(s, `call:${id}`, { calls: 1, storageBytes: 4 * this.operations.reservations().limits.settlementBytes }, rebuilding);
	}

	reserveJob(s: Session, id: string, rebuilding = false) {
		const unit = this.operations.reservations().limits.settlementBytes;
		if (!this.operations.reservations().reserve(s, `job:${id}`, { jobs: 1, inputs: 1, bufferedBytes: unit, storageBytes: 9 * unit }, rebuilding)) {
			throw failure("busy", "No capacity for job and its report");
		}
	}
}
