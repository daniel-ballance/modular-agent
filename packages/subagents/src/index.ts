import type { Actor, AgentEvent, HistoryEntry, InputRequest, InterfaceCapability, JobHandle, JobState, Plugin, PluginApi, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolSource } from "@modular-agent/harness";
import { text, textOf } from "@modular-agent/harness";

export interface SubagentOptions {
	/**
	 * Transient (the default): a subagent whose process stopped is reported to its
	 * parent as having an unknown outcome. Durable: its session is reopened after a
	 * restart, its Runtime decides what happens to its interrupted turn, and the
	 * parent gets the real result.
	 */
	durable?: boolean;
	/** How deep subagents may start subagents. Default 3. */
	maxDepth?: number;
}

/** The parent agent, as an actor in each child session. */
export const PARENT = "parent-agent";

interface Detail { childSessionId: string; task: string; label: string }
interface Link extends Detail { parent: string; jobId: string }
interface Finished { state: Exclude<JobState, "running">; text: string; entryId: string }

const DEFINITION: ToolDefinition = {
	name: "delegate",
	description:
		"Hand a self-contained task to a subagent: another agent with its own session, which starts from the task alone and can't see this conversation. " +
		"By default it runs in the background and its result arrives later as a report, so carry on or end your turn. Set wait to true to get its answer in this call instead. " +
		"To follow up with a subagent that has finished, name it in subagent: it keeps everything from its earlier work.",
	parameters: {
		type: "object",
		properties: {
			task: { type: "string", description: "Everything the subagent needs to know" },
			label: { type: "string", description: "A short name for the subagent" },
			model: { type: "string", description: "provider/id; defaults to this session's model" },
			wait: { type: "boolean" },
			subagent: { type: "string", description: "The label or session id of an earlier subagent to message again" },
		},
		required: ["task"],
	},
	// Starting a subagent changes nothing itself; what the subagent does is checked in its own session.
	hints: { readOnly: true },
	callers: ["model"],
};

function lastTurnEnd(api: PluginApi, sessionId: string): { id: string; outcome: { kind: string; error?: string; limit?: string }; result: { text?: string; openToolCalls: string[] } } | undefined {
	const end = api.history(sessionId, { all: true }).filter((e: HistoryEntry) => e.kind === "turnEnd").at(-1);
	return end && !end.erased ? { id: end.id, ...(end.data as object) } as ReturnType<typeof lastTurnEnd> : undefined;
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
		return { id: PARENT, kind: "agent", authority: owner ? owner.authority.filter((a) => a !== "erase") : ["input", "answer", "tools"] };
	}

	async run(call: ToolCall, ctx: ToolContext): Promise<Omit<ToolResult, "callId">> {
		const input = call.input as { task: string; label?: string; model?: string; wait?: boolean; subagent?: string };
		const parent = ctx.sessionId;
		const settings = this.api.session(parent).settings;
		if (input.subagent) {
			const earlier = this.earlier(parent, input.subagent);
			if (!earlier) return { status: "failed", content: [text(`No earlier subagent called "${input.subagent}".`)] };
			if (this.links.has(earlier.childSessionId)) return { status: "failed", content: [text(`Subagent "${earlier.label}" is still working. Its result will arrive as a report.`)] };
			await this.api.openSession(earlier.childSessionId, this.parentActor(parent));
			return this.begin(parent, { ...earlier, task: input.task }, Boolean(input.wait));
		}
		const depth = (settings.subagentDepth as number | undefined) ?? 0;
		if (depth >= (this.options.maxDepth ?? 3)) return { status: "failed", content: [text("Subagents can't start more subagents at this depth.")] };
		const label = input.label || String(input.task).slice(0, 40);
		const child = await this.api.startSession({
			parentSessionId: parent,
			actor: this.parentActor(parent),
			settings: {
				cwd: this.api.projectOf(parent),
				model: input.model ?? settings.model,
				...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
				...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
				subagentDepth: depth + 1,
			},
		});
		return this.begin(parent, { childSessionId: child, task: input.task, label }, Boolean(input.wait));
	}

	/** The most recent subagent of this parent with this label or session id. */
	private earlier(parent: string, name: string): Detail | undefined {
		return this.api
			.history(parent, { all: true })
			.filter((e: HistoryEntry) => e.kind === "harness.jobStarted" && !e.erased && e.writer === "subagents")
			.map((e: HistoryEntry) => (e.data as { detail: Detail }).detail)
			.filter((d) => d.label === name || d.childSessionId === name)
			.at(-1);
	}

	/** Give a child its task, as a job of the parent. */
	private async begin(parent: string, detail: Detail, wait: boolean): Promise<Omit<ToolResult, "callId">> {
		const { childSessionId: child, label } = detail;
		const job = this.api.startJob(parent, { kind: "subagent", detail });
		const link: Link = { ...detail, parent, jobId: job.id };
		this.links.set(child, link);
		const done = this.watch(link, job);
		await this.api.input(child, { content: detail.task, actorId: PARENT, sources: job.startEntryId ? [job.startEntryId] : undefined });
		if (wait) {
			const finished = await done;
			await job.finish(finished.state, finished.text, { report: false, sources: [finished.entryId] });
			return { status: finished.state === "completed" ? "completed" : "failed", content: [text(finished.text)], value: { childSessionId: child, jobId: job.id } };
		}
		void done.then((finished) => job.finish(finished.state, `Subagent "${label}" ${finished.state}.\n\n${finished.text}`, { sources: [finished.entryId] }));
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
		// The child may close before this runs, for example when the process stops.
		void Promise.resolve()
			.then(() => this.api.waitForIdle(e.sessionId))
			.then(() => this.check(e.sessionId))
			.catch(() => undefined);
	}

	private check(child: string): void {
		const settle = this.waiting.get(child);
		if (!settle || this.api.session(child).busy) return;
		const end = lastTurnEnd(this.api, child);
		if (!end || end.result.openToolCalls.length) return;
		const kind = end.outcome.kind;
		const state = kind === "failed" ? "failed" : kind === "cancelled" ? "cancelled" : "completed";
		const note = kind === "failed" ? `It failed: ${end.outcome.error}` : kind === "limit" ? `It stopped at the ${end.outcome.limit} limit.` : "";
		settle({ state, entryId: end.id, text: [end.result.text ?? "", note].filter(Boolean).join("\n\n") || "(no answer)" });
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
			void done.then((finished) => handle.finish(finished.state, `Subagent "${d.label}" ${finished.state}.\n\n${finished.text}`, { sources: [finished.entryId] }));
			// Reopening the child lets its Runtime decide what happens to an interrupted turn.
			await this.api.openSession(d.childSessionId, this.parentActor(parent));
			// A follow-up job's child already has earlier input: this job's task is given only if it is the latest.
			const latest = this.api.history(d.childSessionId, { all: true }).filter((e: HistoryEntry) => e.kind === "input").at(-1);
			const gaveTask = latest?.message ? textOf(latest.message.content) === d.task : false;
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
