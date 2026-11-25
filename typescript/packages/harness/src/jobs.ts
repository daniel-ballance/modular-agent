import type { JobHandle } from "./plugin-api.js";
import { SessionErasure } from "./session-erasure.js";
import { failure } from "./failure.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { conversation, startOperation, type Operation } from "./telemetry.js";
import { Reservations, resourceBytes } from "./reservations.js";
import { resolve } from "node:path";
import { type QueuedInput, Session } from "./session.js";
import { type AgentEvent, type Authority, type ContentPart, type EntryDraft, type HistoryEntry, type Job, type JobState, type ToolCall, text, zeroUsage } from "./types.js";

export interface JobStart { kind: string; key?: string; actorId?: string; actors?: string[]; jobs?: string[]; toolCallId?: string; detail?: unknown }
export interface KeptJob { job: Job; key?: string; detail?: unknown; actors?: string[]; rights?: Authority[] }

interface JobsOperations {
	erasure(): Pick<SessionErasure, "checkPending">;
	workActors(s: Session): string[];
	turnAuthority(): Pick<AsyncLocalStorage<{ sessionId: string; jobs: Set<string> }>, "getStore">;
	workRights(s: Session, actors: Iterable<string>, jobs?: Iterable<string>): Authority[];
	reservations(): Reservations;
	newId(): string;
	reserveJob(s: Session, id: string): void;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	toolWork(): Pick<AsyncLocalStorage<ToolCall>, "getStore">;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	problem(plugin: string, where: string, error: unknown): void;
	admit<T>(s: Session, work: () => Promise<T>): Promise<T>;
	jobReportsStartTurns(): boolean;
	startQueued(s: Session): void;
	acceptInput(s: Session, q: QueuedInput): Promise<unknown>;
}

export class Jobs {
	constructor(private readonly operations: JobsOperations) {}

	jobSpans = new WeakMap<Session, Map<string, Operation>>();

	jobCancels = new Map<string, (jobId: string) => Promise<void>>();

	startJob(s: Session, options: JobStart, plugin: string): JobHandle {
		this.operations.erasure().checkPending(s);
		if (s.provisional) throw failure("invalid_request", "Session has not admitted its first input");
		if (s.moving || s.closing || s.closed || s.suspended || s.erasing) throw failure("invalid_request", "Session cannot start jobs right now");
		const current = [...this.operations.workActors(s), ...(options.actors ?? [])];
		const actorId = current[0] ?? options.actorId ?? [...s.actors.keys()][0];
		const actors = [...new Set([actorId, ...current, options.actorId].filter((id): id is string => id !== undefined))];
		const context = this.operations.turnAuthority().getStore();
		const rights = this.operations.workRights(s, actors, context?.sessionId === s.id ? context.jobs : options.jobs);
		if (!actorId || !rights.includes("jobs")) throw failure("invalid_request", 'Job requires the "jobs" right');
		const { key, detail } = options;
		if (key !== undefined) {
			const active = [...s.jobs.values()].find((r) => r.key === key && r.job.plugin === plugin);
			const id = active?.job.id ?? s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.writer === plugin && !s.copied.has(e.id) && (e.data as { key?: string } | undefined)?.key === key)?.jobId;
			if (id) return { id, started: false, ready: active?.handle.ready ?? Promise.resolve(), finish: async () => {}, progress: () => {}, onCancel: () => {} };
		}
		if (resourceBytes(options) + 2048 > this.operations.reservations().limits.settlementBytes) throw failure("busy", "Job start exceeds capacity");
		const startEntryId = this.operations.newId();
		const job: Job = { id: this.operations.newId(), kind: options.kind, sessionId: s.id, plugin, actorId, turnId: s.running?.turnId, state: "running", usage: zeroUsage() };
		this.operations.reserveJob(s, job.id);
		const span = this.observeJob(s, job);
		const ready = span.run(() => this.operations.commit(s, [{
			id: startEntryId, kind: "jobStarted", writer: plugin, modelVisible: false, turnId: job.turnId,
			toolCallId: options.toolCallId ?? this.operations.toolWork().getStore()?.id, jobId: job.id, actorId,
			data: { kind: job.kind, key, detail: detail ?? null, actors, rights, authorizers: actors.map(actorId => ({ sessionId: s.id, actorId })) },
		}])).then(() => this.operations.emit(s, "job.started", { job }, plugin, { jobId: job.id }));
		void ready.catch((error) => { span.fail("failed"); span.end(); this.jobSpans.get(s)?.delete(job.id); s.jobs.delete(job.id); this.operations.problem(plugin, "record job", error); });
		return this.jobHandle(s, { job, key, detail, actors, rights }, startEntryId, ready);
	}

	private observeJob(s: Session, job: Job): Operation {
		let spans = this.jobSpans.get(s);
		if (!spans) { spans = new Map(); this.jobSpans.set(s, spans); }
		let span = spans.get(job.id);
		if (!span) {
			span = startOperation("modular_agent.job", { ...conversation(s.id), "modular_agent.job.id": job.id, "modular_agent.turn.id": job.turnId,
				"modular_agent.job.outcome": "interrupted" });
			spans.set(job.id, span);
		}
		return span;
	}

	endJobObservation(s: Session): void {
		for (const span of this.jobSpans.get(s)?.values() ?? []) span.end();
		this.jobSpans.delete(s);
	}

	readJob(s: Session, e: HistoryEntry): KeptJob | undefined {
		if (!e.jobId || e.erased || s.copied.has(e.id)) return undefined;
		if (e.kind === "harness.jobStarted") return e.data as KeptJob;
		if (e.kind !== "jobStarted") return undefined;
		const data = e.data as Omit<KeptJob, "job"> & { kind: string };
		return { ...data, job: { id: e.jobId, kind: data.kind, sessionId: s.id, plugin: e.writer, actorId: e.actorId, turnId: e.turnId, state: "running", usage: zeroUsage() } };
	}

	runningJobs(s: Session): KeptJob[] {
		const all = s.order.map((id) => s.entries.get(id)!);
		const ended = new Set(all.filter((e) => e.kind === "jobEnded" || e.kind === "harness.jobEnded").map((e) => e.jobId));
		const jobs = new Map<string, KeptJob>();
		for (const e of all) {
			const kept = this.readJob(s, e);
			if (kept && !ended.has(e.jobId)) jobs.set(kept.job.id, kept);
		}
		for (const [id, active] of s.jobs) if (!ended.has(id)) jobs.set(id, active);
		return [...jobs.values()];
	}

	jobHandle(s: Session, kept: KeptJob, startEntryId?: string, ready: Promise<unknown> = Promise.resolve()): JobHandle {
		const { job } = kept;
		const plugin = job.plugin;
		const span = this.observeJob(s, job);
		const handle: JobHandle = {
			id: job.id, started: true, ready, startEntryId,
			progress: (content) => {
				if (!record.ending && !s.suspended && !s.closed) this.operations.emit(s, "job.progress", { content: typeof content === "string" ? [text(content)] : content }, plugin, { jobId: job.id });
			},
			finish: (state, result, options) => {
				if (record.ending) return Promise.reject(new Error("Job already ended"));
				const work = async () => {
					await ready;
					if (s.closed || s.suspended) return;
					const raw = typeof result === "string" ? [text(result)] : result;
					const oversized = resourceBytes(raw) + 2048 > this.operations.reservations().limits.settlementBytes;
					const content = oversized ? [text("result_too_large")] : raw;
					const outcome = state === "outcomeUnknown"
						? { kind: "failed", error: "Job outcome is unknown" }
						: { kind: state, error: options?.error };
					await this.operations.admit(s, async () => {
						const rights = this.operations.workRights(s, [], [job.id]);
						const report = options?.report !== false && !s.closing && !s.erasing && rights.includes("input");
						const end: EntryDraft = { id: this.operations.newId(), kind: "jobEnded", writer: plugin, modelVisible: false, jobId: job.id, sources: options?.sources, data: { outcome, result: content, report } };
						let queued: QueuedInput | undefined;
						const drafts = [end];
						if (report && !s.keys.has(`job:${job.id}`)) {
							if (!this.operations.workRights(s, [], [job.id]).includes("input")) throw failure("invalid_request", 'Job report requires the "input" right');
							queued = { id: this.operations.newId(), actorId: job.actorId ?? "harness", when: this.operations.jobReportsStartTurns() ? "after" : "propose", key: `job:${job.id}`, kind: "input",
								startedBy: { kind: "job", id: job.id }, startingRights: rights, sources: [end.id!], content: content ?? [] };
							drafts.push({ kind: "inputAccepted", writer: "harness", modelVisible: false, inputId: queued.id, actorId: queued.actorId, jobId: job.id,
								sources: queued.sources, data: { key: queued.key, content: queued.content, when: queued.when, taken: queued.when === "propose" ? "proposed" : "after", parked: queued.when === "propose", rights, authorizers: (kept.actors ?? []).map(actorId => ({ sessionId: s.id, actorId })) } });
						}
						await this.operations.commit(s, drafts);
						if (queued) this.operations.reservations().transfer(s, `job:${job.id}`, `input:${queued.id}`, {
							inputs: 1, bufferedBytes: resourceBytes(queued), storageBytes: 5 * this.operations.reservations().limits.settlementBytes,
						});
						else this.operations.reservations().release(s, `job:${job.id}`);
						span.set("modular_agent.job.outcome", outcome.kind);
						if (outcome.kind === "failed") span.fail("failed");
						span.end();
						this.jobSpans.get(s)?.delete(job.id);
						job.state = state;
						job.result = content;
						this.operations.emit(s, "job.ended", { state, result: content }, plugin, { jobId: job.id });
						if (queued) {
							const admission = startOperation("modular_agent.input.admit", { ...conversation(s.id), "modular_agent.input.id": queued.id },
								{ links: span.spanContext ? [span.spanContext] : [] });
							queued.trace = admission.spanContext;
							admission.end();
						}
						if (queued?.when === "after") { s.followUps.push(queued); this.operations.startQueued(s); }
					});
					if (oversized) throw failure("result_too_large", "Job result exceeds reserved capacity");
				};
				record.ending = span.run(work).catch((error) => { if (job.state === "running") record.ending = undefined; throw error; });
				return record.ending.finally(() => { if (job.state !== "running") s.jobs.delete(job.id); });
			},
			onCancel: (fn) => { record.cancel = fn; },
		};
		const record: import("./session.js").JobRecord = { ...kept, handle };
		s.jobs.set(job.id, record);
		return handle;
	}

	async reportJob(s: Session, { job }: KeptJob, end: HistoryEntry): Promise<void> {
		const data = end.data as { result?: ContentPart[]; outcome: { kind: JobState } };
		const key = `job:${job.id}`;
		await this.operations.admit(s, async () => {
			if (s.keys.has(key) || s.closed || s.closing || s.suspended || !this.operations.workRights(s, [], [job.id]).includes("input")) return;
			await this.operations.acceptInput(s, {
				id: this.operations.newId(), actorId: job.actorId ?? "harness", when: this.operations.jobReportsStartTurns() ? "after" : "propose", key, kind: "input",
				startedBy: { kind: "job", id: job.id }, sources: [end.id],
				content: data.result ?? [],
			});
		});
	}

	async cancelJob(s: Session, jobId: string): Promise<void> {
		const kept = this.runningJobs(s).find(({ job }) => job.id === jobId);
		if (!kept) { await s.jobs.get(jobId)?.ending; return; }
		const handle = s.jobs.get(jobId)?.handle ?? this.jobHandle(s, kept);
		const record = s.jobs.get(jobId)!;
		if (record.cancelling) return record.cancelling;
		const cancel = async () => {
			if (record.ending) return record.ending;
			try {
				if (record.cancel) await record.cancel();
				else await this.jobCancels.get(kept.job.plugin)?.(jobId);
			} catch (error) { this.operations.problem(kept.job.plugin, "cancel job", error); }
			if (record.ending) await record.ending;
			else await handle.finish("cancelled", undefined, { report: false });
		};
		record.cancelling = cancel();
		return record.cancelling;
	}
}
