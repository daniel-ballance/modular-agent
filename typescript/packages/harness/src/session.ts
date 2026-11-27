import type { JobHandle } from "./plugin-api.js";
import { modelView } from "./view.js";
import { erasedEntry } from "./types.js";
import type { Actor, AgentEvent, Answer, ContentPart, HistoryEntry, InputRequest, Job, ModelMessage, StoredSession } from "./types.js";

export function inputIdOf(entry: HistoryEntry): string | undefined {
	return entry.inputId;
}

export function inputKeyScope(key: string, actorId?: string, submittedBy = actorId): string {
	// Reserved job keys belong to a host-assigned job, not to an input principal.
	return key.startsWith("job:") ? key : JSON.stringify([submittedBy, actorId, key]);
}

export type InputTiming = "now" | "steer" | "after" | "propose";
export interface QueuedInput {
	trace?: import("@opentelemetry/api").SpanContext;
	id: string;
	content: ContentPart[];
	resultShape?: Record<string, unknown>;
	actorId: string;
	when: InputTiming;
	key?: string;
	time?: number;
	releasedBy?: string;
	delegatedBy?: string;
	authorityActors?: string[];
	startingRights?: Actor["authority"];
	connectionRights?: Record<string, Actor["authority"]>;
	authorityJobs?: string[];
	sources?: string[];
	startedBy: { kind: "actor" | "job" | "plugin" | "answer" | "toolResult"; id: string };
	kind: string;
	/** Set when this is not input but a continuation of tool calls left open past an earlier turn. */
	continueTurnId?: string;
}
export interface InputReceipt { inputId: string; taken: "now" | "inTurn" | "after" | "proposed" | "handedBack"; duplicate?: boolean; erased?: true }

export interface RunningTurn { turnId: string; abort: AbortController; done: Promise<void>; steeringClosed?: boolean }
export interface OpenRequest {
	request: InputRequest;
	resolve(answer: Answer): Promise<Answer>;
	timer?: NodeJS.Timeout;
}
export interface JobRecord {
	job: Job;
	key?: string;
	detail?: unknown;
	actors?: string[];
	rights?: Actor["authority"];
	handle: JobHandle;
	cancel?: () => void | Promise<void>;
	cancelling?: Promise<void>;
	ending?: Promise<void>;
}

/** One session: identity, settings, actors, current position and history. */
export class Session {
	readonly entries = new Map<string, HistoryEntry>();
	readonly copied = new Set<string>();
	private forkSetup = false;
	readonly order: string[] = [];
	position: string | null = null;
	settings: Record<string, unknown> = {};
	readonly actors = new Map<string, Actor>();
	limit: Actor["authority"] | null = null;
	tenant?: string;
	steering: QueuedInput[] = [];
	followUps: QueuedInput[] = [];
	readonly proposals = new Map<string, QueuedInput>();
	readonly admissions = new Map<string, QueuedInput>();
	admissionsInFlight = 0;
	admitting: Promise<unknown> = Promise.resolve();
	readonly keys = new Map<string, InputReceipt>();
	readonly erasedKeys = new Set<string>();
	running?: RunningTurn;
	readonly jobs = new Map<string, JobRecord>();
	readonly requests = new Map<string, OpenRequest>();
	readonly waiting = new Set<string>();
	readonly revokedQuestions = new Set<string>();
	readonly recent: AgentEvent[] = [];
	/** Recipients following this session, each through the output gate. */
	readonly followers = new Set<{ recipient: string; push(event: AgentEvent): void; idle(): Promise<void> }>();
	/** A new persistent session with setup in memory but no durable writer yet. */
	provisional = false;
	closed = false;
	closing = false;
	reopening = false;
	erasing = false;
	moving = false;
	hasWaitingApprovals = false;
	outsideTools = 0;
	recoveredInput: QueuedInput[] = [];
	/** The process stopped its part in this session; nothing more is recorded here. */
	suspended = false;
	readonly interruption = new AbortController();
	readonly closeSignal = new AbortController();
	unwatchWriter?: () => void;
	/** Commits run one at a time, so each entry follows the one before it. */
	committing: Promise<unknown> = Promise.resolve();
	/** Work started by a late answer, which waitForIdle also waits for. */
	settling?: Promise<void>;
	/** Late answers accepted but not yet recorded: one answer closes a question. */
	readonly lateAnswers = new Set<string>();

	constructor(readonly meta: StoredSession, readonly ephemeral: boolean) {}

	get id(): string {
		return this.meta.id;
	}

	/** Apply a committed entry to the in-memory record. */
	apply(entry: HistoryEntry): void {
		const existing = this.entries.get(entry.id);
		this.entries.set(entry.id, entry);
		if (!existing) this.order.push(entry.id);
		if (this.meta.forkedFrom && !this.forkSetup && (entry.sources?.length || entry.erased)) {
			this.copied.add(entry.id);
			this.position = entry.id;
			return;
		}
		this.forkSetup = true;
		if (["inputAccepted", "input", "inputHandedBack"].includes(entry.kind) && (typeof entry.inputId !== "string" || !entry.inputId)) throw new Error("Missing input identity");
		if (["inputRequest", "inputAnswer", "secretAnswerAccepted"].includes(entry.kind) && (typeof entry.requestId !== "string" || !entry.requestId)) throw new Error("Missing question identity");
		if (entry.kind === "inputRequest" && (entry.data as { request?: { approvalWait?: string } })?.request?.approvalWait === "untilDeadline") this.hasWaitingApprovals = true;
		// A key is remembered for the session's life, across restarts, so it is rebuilt from the record.

		if (entry.erased) {
			if ((entry.kind === "input" || entry.kind === "inputHandedBack") && entry.inputId) {
				this.admissions.delete(entry.inputId); this.proposals.delete(entry.inputId);
			}
			if (!existing && entry.kind !== "position") this.position = entry.id;
			return;
		}
		switch (entry.kind) {
			case "inputAccepted": {
				const { key, content, when, releasedBy, submittedBy, delegatedBy = submittedBy, taken, parked, connectionRights, rights } = entry.data as {
					rights?: Actor["authority"];
					connectionRights?: QueuedInput["connectionRights"];
					key?: string; content: ContentPart[]; when: InputTiming; releasedBy?: string; submittedBy?: string; delegatedBy?: string; taken?: InputReceipt["taken"]; parked?: boolean;
				};
				const inputId = entry.inputId;
				if (!inputId || !Array.isArray(content) || (releasedBy ? !this.proposals.has(inputId) :
					entry.jobId ? typeof parked !== "boolean" : !["now", "after", "inTurn", "proposed"].includes(taken!))) throw new Error("Incomplete input admission");
				const actorId = entry.actorId!;
				const startedBy = entry.jobId ? { kind: "job" as const, id: entry.jobId } : { kind: "actor" as const, id: actorId };
				const queued = { id: inputId, actorId, key, content, when, releasedBy, delegatedBy, time: entry.time, kind: "input", startedBy, connectionRights, startingRights: rights };
				this.admissions.set(inputId, queued);
				if (when === "propose" || parked === true && !releasedBy) this.proposals.set(inputId, queued);
				else this.proposals.delete(inputId);
				const scoped = key && inputKeyScope(key, actorId, submittedBy ?? delegatedBy);
				if (!releasedBy && scoped && !this.keys.has(scoped) && !this.erasedKeys.has(scoped)) this.keys.set(scoped, { inputId, taken: taken ?? (parked ? "proposed" : "after") });
				break;
			}
			case "inputHandedBack":
				if (entry.inputId) { this.admissions.delete(entry.inputId); this.proposals.delete(entry.inputId); }
				break;
			case "input": {
				const inputId = inputIdOf(entry);
				if (inputId) {
					this.admissions.delete(inputId);
				}
				break;
			}
			case "position":
				this.position = (entry.data as { to: string | null }).to;
				return;
			case "setting": {
				const { key, value } = entry.data as { key: string; value: unknown };
				if (key === "settings" && value && typeof value === "object") Object.assign(this.settings, value);
				else this.settings[key === "thinking" ? "reasoning" : key === "approvalPolicy" ? "approval" : key] = value;
				break;
			}
			case "limit":
				this.limit = (entry.data as { rights: Actor["authority"] | null }).rights;
				break;
			case "tenant":
				this.tenant = (entry.data as { tenant: string }).tenant;
				break;
			case "actorJoined": {
				const { rights, ...actor } = (entry.data as { actor: Actor & { rights?: Actor["authority"] } }).actor;
				this.actors.set(actor.id, { ...actor, authority: rights ?? actor.authority ?? [] });
				break;
			}
			case "actorLeft":
				this.actors.delete((entry.data as { actorId: string }).actorId);
				break;
			case "erasure": {
				for (const { key, inputId, actorId, submittedBy } of (entry.data as { inputKeys?: { key: string; inputId: string; actorId?: string; submittedBy?: string }[] }).inputKeys ?? []) {
					const scoped = inputKeyScope(key, actorId, submittedBy);
					this.erasedKeys.add(scoped);
					this.keys.delete(scoped);
					this.admissions.delete(inputId);
					this.proposals.delete(inputId);
				}
				for (const id of (entry.data as { entryIds: string[] }).entryIds) {
					const target = this.entries.get(id);
					const inputId = target && inputIdOf(target);
					if (inputId) {
						for (const [key, receipt] of this.keys) if (receipt.inputId === inputId) this.keys.delete(key);
						this.admissions.delete(inputId);
						this.proposals.delete(inputId);
					}
					if (target && !target.erased) this.entries.set(id, erasedEntry(target));
				}
				break;
			}
		}
		if (!existing) this.position = entry.id;
	}

	/** The entries on the current branch, oldest first. */
	branch(): HistoryEntry[] {
		const out: HistoryEntry[] = [];
		let id = this.position;
		const seen = new Set<string>();
		while (id && !seen.has(id)) {
			seen.add(id);
			const entry = this.entries.get(id);
			if (!entry) break;
			out.push(entry);
			id = entry.parentId;
		}
		return out.reverse();
	}

	/** The model-visible messages on the current branch. */
	modelMessages(entries: HistoryEntry[] = this.branch(), turnId?: string): ModelMessage[] {
		return modelView(entries, turnId);
	}

	unresolvedRewind() {
		const entry = this.entries.get(this.order.at(-1) ?? "");
		if (entry?.kind !== "position") return;
		const data = entry.data as { to: string | null; restore?: { point: string; undo: string } };
		if (data.restore) return { entry, to: data.to, restore: data.restore };
	}

	isBusy(): boolean {
		return this.running !== undefined;
	}

	remember(event: AgentEvent, limit = 500): void {
		this.recent.push(event);
		if (this.recent.length > limit) this.recent.splice(0, this.recent.length - limit);
	}
}
