import type { JobHandle } from "./harness.js";
import { modelView } from "./view.js";
import { erasedEntry } from "./types.js";
import type { Actor, AgentEvent, Answer, ContentPart, HistoryEntry, InputRequest, Job, ModelMessage, StoredSession } from "./types.js";

export type InputTiming = "now" | "steer" | "after" | "propose";
export interface QueuedInput {
	id: string;
	content: ContentPart[];
	actorId: string;
	when: InputTiming;
	key?: string;
	time?: number;
	releasedBy?: string;
	delegatedBy?: string;
	authorityActors?: string[];
	authorityJobs?: string[];
	sources?: string[];
	startedBy: { kind: "actor" | "job" | "plugin" | "answer"; id: string };
	kind: string;
	/** Set when this is not input but a continuation of tool calls left open past an earlier turn. */
	continueCalls?: string[];
}
export interface InputReceipt { inputId: string; taken: "now" | "inTurn" | "after" | "proposed" | "handedBack"; duplicate?: boolean }

export interface RunningTurn { turnId: string; abort: AbortController; done: Promise<void> }
export interface OpenRequest {
	request: InputRequest;
	resolve(answer: Answer): void;
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
	admitting: Promise<unknown> = Promise.resolve();
	readonly keys = new Map<string, InputReceipt>();
	running?: RunningTurn;
	readonly jobs = new Map<string, JobRecord>();
	readonly requests = new Map<string, OpenRequest>();
	readonly waiting = new Set<string>();
	readonly recent: AgentEvent[] = [];
	/** Recipients following this session, each through the output gate. */
	readonly followers = new Set<{ recipient: string; push(event: AgentEvent): void; idle(): Promise<void> }>();
	closed = false;
	closing = false;
	reopening = false;
	erasing = false;
	moving = false;
	outsideTools = 0;
	recoveredInput: QueuedInput[] = [];
	/** The process stopped its part in this session; nothing more is recorded here. */
	suspended = false;
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
		// A key is remembered for the session's life, across restarts, so it is rebuilt from the record.

		if (entry.erased) {
			if (!existing && entry.kind !== "position") this.position = entry.id;
			return;
		}
		switch (entry.kind) {
			case "inputAccepted": {
				const { inputId, key, content, when, releasedBy, delegatedBy, taken } = entry.data as {
					inputId: string; key?: string; content: ContentPart[]; when: InputTiming; releasedBy?: string; delegatedBy?: string; taken?: InputReceipt["taken"];
				};
				const actorId = entry.actorId!;
				const startedBy = entry.jobId ? { kind: "job" as const, id: entry.jobId } : { kind: "actor" as const, id: actorId };
				const queued = { id: inputId, actorId, key, content, when, releasedBy, delegatedBy, time: entry.time, kind: "input", startedBy };
				this.admissions.set(inputId, queued);
				if (when === "propose") this.proposals.set(inputId, queued);
				else this.proposals.delete(inputId);
				if (key && !this.keys.has(key)) this.keys.set(key, { inputId, taken: taken ?? (when === "propose" ? "proposed" : when === "steer" ? "inTurn" : when) });
				break;
			}
			case "inputHandedBack":
				for (const id of (entry.data as { inputIds: string[] }).inputIds) { this.admissions.delete(id); this.proposals.delete(id); }
				break;
			case "input": {
				const { inputId, key } = (entry.data ?? {}) as { inputId?: string; key?: string };
				if (inputId) {
					this.admissions.delete(inputId);
					if (key && !this.keys.has(key)) this.keys.set(key, { inputId, taken: "now" });
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
				for (const id of (entry.data as { entryIds: string[] }).entryIds) {
					const target = this.entries.get(id);
					// Erasing an input also forgets its key.
					const erasedKey = (target?.data as { key?: string } | undefined)?.key;
					if (erasedKey) this.keys.delete(erasedKey);
					const inputId = (target?.data as { inputId?: string } | undefined)?.inputId;
					if (inputId) { this.admissions.delete(inputId); this.proposals.delete(inputId); }
					if (target) this.entries.set(id, erasedEntry(target));
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

	isBusy(): boolean {
		return this.running !== undefined;
	}

	remember(event: AgentEvent, limit = 500): void {
		this.recent.push(event);
		if (this.recent.length > limit) this.recent.splice(0, this.recent.length - limit);
	}
}
