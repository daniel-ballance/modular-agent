import type { Actor, AgentEvent, HistoryEntry, InputRequest, InterfaceCapability, JobHandle, JobState, Plugin, PluginApi, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolSource } from "@modular-agent/harness";
import { text } from "@modular-agent/harness";

export interface SubagentOptions {
	/**
	 * Transient (the default): a subagent whose process stopped is reported to its
	 * parent as having an unknown outcome. Durable: its session is reopened after a
	 * restart, its Runtime decides what happens to its interrupted turn, and the
	 * parent gets the real result.
	 */
	durable?: boolean;
	/** How deep subagents may start subagents. Default 2. */
	maxDepth?: number;
}

/** The parent agent, as an actor in each child session. */
export const PARENT = "parent-agent";

interface Detail { childSessionId: string; task: string; label: string }
interface Link extends Detail { parent: string; jobId: string }
interface Finished { state: Exclude<JobState, "running">; text: string }

const DEFINITION: ToolDefinition = {
	name: "delegate",
	description:
		"Hand a self-contained task to a subagent: another agent with its own session, which starts from the task alone and can't see this conversation. " +
		"By default it runs in the background and its result arrives later as a report, so carry on or end your turn. Set wait to true to get its answer in this call instead.",
	parameters: {
		type: "object",
		properties: {
			task: { type: "string", description: "Everything the subagent needs to know" },
			label: { type: "string", description: "A short name for the subagent" },
			model: { type: "string", description: "provider/id; defaults to this session's model" },
			wait: { type: "boolean" },
		},
		required: ["task"],
	},
	// Starting a subagent changes nothing itself; what the subagent does is checked in its own session.
	hints: { readOnly: true },
	callers: ["model"],
};

function lastTurnEnd(api: PluginApi, sessionId: string): { outcome: { kind: string; error?: string; limit?: string }; result: { text?: string; openToolCalls: string[] } } | undefined {
	const end = api.history(sessionId, { all: true }).filter((e: HistoryEntry) => e.kind === "turnEnd").at(-1);
	return end?.data as never;
}

/**
 * Subagents, built on jobs. Each subagent is a child session started by a job of
 * the parent session. The parent agent is an actor in the child: the child's
 * questions and approvals go to the parent, which passes them to its own user.
 */
export class Subagents implements ToolSource, InterfaceCapability {
	readonly id = "subagents";
	readonly actorId = PARENT;
	private links = new Map<string, Link>();
	private waiting = new Map<string, (finished: Finished) => void>();

	constructor(private api: PluginApi, private options: SubagentOptions) {}

	tools(): ToolDefinition[] {
		return [DEFINITION];
	}

	/** The parent agent's authority in a child: no more than the parent session's owner has. */
	private parentActor(parent: string): Actor {
		const owner = this.api.session(parent).actors[0];
		return { id: PARENT, kind: "agent", authority: owner ? owner.authority.filter((a) => a !== "erase") : ["input", "answer"] };
	}

	async run(call: ToolCall, ctx: ToolContext): Promise<Omit<ToolResult, "callId">> {
		const input = call.input as { task: string; label?: string; model?: string; wait?: boolean };
		const parent = ctx.sessionId;
		const settings = this.api.session(parent).settings;
		const depth = (settings.subagentDepth as number | undefined) ?? 0;
		if (depth >= (this.options.maxDepth ?? 2)) return { status: "failed", content: [text("Subagents can't start more subagents at this depth.")] };
		const label = input.label || String(input.task).slice(0, 40);
		const child = await this.api.startSession({
			parentSessionId: parent,
			actor: this.parentActor(parent),
			settings: {
				cwd: this.api.projectOf(parent),
				model: input.model ?? settings.model,
				...(settings.thinking ? { thinking: settings.thinking } : {}),
				...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
				subagentDepth: depth + 1,
			},
		});
		const job = this.api.startJob(parent, { kind: "subagent", detail: { childSessionId: child, task: input.task, label } satisfies Detail });
		const link: Link = { childSessionId: child, task: input.task, label, parent, jobId: job.id };
		this.links.set(child, link);
		const done = this.watch(link, job);
		await this.api.input(child, { content: input.task, actorId: PARENT });
		if (input.wait) {
			const finished = await done;
			await job.finish(finished.state, finished.text, { report: false });
			return { status: finished.state === "completed" ? "completed" : "failed", content: [text(finished.text)], value: { childSessionId: child } };
		}
		void done.then((finished) => job.finish(finished.state, `Subagent "${label}" ${finished.state}.\n\n${finished.text}`));
		return { status: "completed", content: [text(`Started subagent "${label}" (job ${job.id.slice(0, 8)}). Its result will arrive later as a report.`)], value: { jobId: job.id, childSessionId: child } };
	}

	/** Resolves once the child has nothing more to do: its last turn ended with no call left open. */
	private watch(link: Link, job: JobHandle): Promise<Finished> {
		job.onCancel(async () => {
			this.waiting.delete(link.childSessionId);
			this.links.delete(link.childSessionId);
			await this.api.closeSession(link.childSessionId).catch(() => undefined);
		});
		return new Promise((resolve) => {
			this.waiting.set(link.childSessionId, (finished) => {
				this.waiting.delete(link.childSessionId);
				this.links.delete(link.childSessionId);
				void this.api.closeSession(link.childSessionId).catch(() => undefined);
				resolve(finished);
			});
		});
	}

	/** Raw events: a child's turn ended. Decide once the child is idle. */
	onAgentEvent(e: AgentEvent): void {
		if (e.type !== "turn.ended" || !this.waiting.has(e.sessionId)) return;
		void this.api.waitForIdle(e.sessionId).then(() => this.check(e.sessionId));
	}

	private check(child: string): void {
		const settle = this.waiting.get(child);
		if (!settle || this.api.session(child).busy) return;
		const end = lastTurnEnd(this.api, child);
		if (!end || end.result.openToolCalls.length) return;
		const kind = end.outcome.kind;
		const state = kind === "failed" ? "failed" : kind === "cancelled" ? "cancelled" : "completed";
		const note = kind === "failed" ? `It failed: ${end.outcome.error}` : kind === "limit" ? `It stopped at the ${end.outcome.limit} limit.` : "";
		settle({ state, text: [end.result.text ?? "", note].filter(Boolean).join("\n\n") || "(no answer)" });
	}

	// ---------- the child's questions go to the parent ----------

	onInputRequest(request: InputRequest): void {
		const link = this.links.get(request.sessionId);
		if (!link) return;
		void this.api
			.ask(link.parent, {
				kind: request.kind,
				question: `[subagent "${link.label}"] ${request.question}`,
				details: request.details,
				options: request.options,
				...(request.timeLimitMs ? { timeLimitMs: request.timeLimitMs, whenTimeLimit: request.whenTimeLimit } : {}),
				key: request.key ? `subagent:${link.childSessionId}:${request.key}` : undefined,
			})
			.then((answer) => {
				if (answer.pending) return; // left open in the parent; the child's own time limit decides for the child
				this.api.answer(request.sessionId, { requestId: request.id, actorId: PARENT, value: answer.value, declined: answer.declined, reason: answer.reason });
			});
	}

	// ---------- after a restart ----------

	async recover(parent: string): Promise<void> {
		for (const { job, detail } of this.api.unfinishedJobs(parent)) {
			if (job.kind !== "subagent") continue;
			const d = detail as Detail;
			const handle = this.api.resumeJob(parent, job.id);
			if (!this.options.durable) {
				await handle.finish("outcomeUnknown", `Subagent "${d.label}" was interrupted when the process stopped. Its outcome is unknown. Its session was ${d.childSessionId}.`);
				continue;
			}
			const link: Link = { ...d, parent, jobId: job.id };
			this.links.set(d.childSessionId, link);
			const done = this.watch(link, handle);
			void done.then((finished) => handle.finish(finished.state, `Subagent "${d.label}" ${finished.state}.\n\n${finished.text}`));
			// Reopening the child lets its Runtime decide what happens to an interrupted turn.
			await this.api.openSession(d.childSessionId, this.parentActor(parent));
			const gaveTask = this.api.history(d.childSessionId, { all: true }).some((e: HistoryEntry) => e.kind === "input");
			if (!gaveTask) await this.api.input(d.childSessionId, { content: d.task, actorId: PARENT });
			else if (!this.api.session(d.childSessionId).busy) this.check(d.childSessionId);
		}
	}
}

export function subagents(options: SubagentOptions = {}): Plugin & { name: string } {
	return {
		// One name for both variants, so a restart with the other variant still finds its jobs.
		name: "subagents",
		setup(api) {
			const s = new Subagents(api, options);
			api.provide("tool-source", s);
			api.provide("interface", s);
			api.onEvent((e) => s.onAgentEvent(e), { raw: true });
			api.on("session.start", async (p: { sessionId: string; resumed: boolean }) => {
				if (p.resumed) await s.recover(p.sessionId);
			});
		},
	};
}
