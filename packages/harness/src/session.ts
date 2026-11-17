import { pairToolResults } from "./view.js";
import type { Actor, AgentEvent, Answer, ContentPart, HistoryEntry, InputRequest, Job, ModelMessage, StoredSession } from "./types.js";

export type InputTiming = "now" | "steer" | "after";
export interface QueuedInput {
	id: string;
	content: ContentPart[];
	actorId: string;
	when: InputTiming;
	key?: string;
	startedBy: { kind: "actor" | "job" | "plugin" | "answer"; id: string };
	kind: string;
	/** Set when this is not input but a continuation of tool calls left open past an earlier turn. */
	continueCalls?: string[];
}
export interface InputReceipt { inputId: string; taken: "now" | "inTurn" | "after"; duplicate?: boolean }

export interface RunningTurn { turnId: string; abort: AbortController; done: Promise<void> }
export interface OpenRequest {
	request: InputRequest;
	resolve(answer: Answer): void;
	timer?: NodeJS.Timeout;
}
export interface JobRecord { job: Job; cancel?: () => void | Promise<void> }

/** One session: identity, settings, actors, current position and history. */
export class Session {
	readonly entries = new Map<string, HistoryEntry>();
	readonly order: string[] = [];
	position: string | null = null;
	settings: Record<string, unknown> = {};
	readonly actors = new Map<string, Actor>();
	steering: QueuedInput[] = [];
	followUps: QueuedInput[] = [];
	readonly keys = new Map<string, InputReceipt>();
	running?: RunningTurn;
	readonly jobs = new Map<string, JobRecord>();
	readonly requests = new Map<string, OpenRequest>();
	readonly recent: AgentEvent[] = [];
	/** Recipients following this session, each through the output gate. */
	readonly followers = new Set<{ push(event: AgentEvent): void }>();
	closed = false;
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
		switch (entry.kind) {
			case "position":
				this.position = (entry.data as { to: string | null }).to;
				return;
			case "setting": {
				const { key, value } = entry.data as { key: string; value: unknown };
				this.settings[key] = value;
				break;
			}
			case "actorJoined": {
				const actor = (entry.data as { actor: Actor }).actor;
				this.actors.set(actor.id, actor);
				break;
			}
			case "actorLeft":
				this.actors.delete((entry.data as { actorId: string }).actorId);
				break;
			case "erasure": {
				for (const id of (entry.data as { entryIds: string[] }).entryIds) {
					const target = this.entries.get(id);
					if (target) this.entries.set(id, { ...target, message: undefined, data: { erased: true }, modelVisible: false });
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
	modelMessages(entries: HistoryEntry[] = this.branch()): ModelMessage[] {
		return pairToolResults(entries.filter((e) => e.modelVisible && e.message).map((e) => e.message!));
	}

	isBusy(): boolean {
		return this.running !== undefined;
	}

	remember(event: AgentEvent, limit = 500): void {
		this.recent.push(event);
		if (this.recent.length > limit) this.recent.splice(0, this.recent.length - limit);
	}
}
