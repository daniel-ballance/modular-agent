import {
	type AssistantMessage,
	type GateResult,
	type HistoryEntry,
	type InterruptedTurn,
	type ModelError,
	type ModelRequest,
	type Outcome,
	type Plugin,
	type Runtime,
	type RuntimeHost,
	type ToolCall,
	type ToolCallPart,
	type ToolResult,
	type TurnInput,
	type TurnOutcome,
	type Usage,
	addUsage,
	isPending,
	isToolCall,
	pendingToolCalls,
	text,
	textOf,
	zeroUsage,
} from "@modular-agent/harness";

interface Prepared { call: ToolCall; refused?: string; pending?: string; result?: ToolResult }

export interface TurnProgress {
	entries: string[];
	usage: Usage;
	steps: number;
	/** Ordered by offer, not by the order in which parallel calls reply. */
	calls: Map<string, boolean>;
}

interface TurnExit { outcome: Outcome; text?: string }
const hasOpenCalls = (progress: TurnProgress) => [...progress.calls.values()].some(Boolean);

export interface TransientRuntimeOptions {
	/** Default step limit when the session sets none. */
	maxSteps?: number;
	/** Retries of a failed model request that a plugin asked to retry. */
	maxRetries?: number;
}

/**
 * A transient Runtime: a turn lives only while this process runs.
 * It runs steps, asks the Harness to run tool calls and to let plugins step in,
 * and ends the turn with an outcome and a result.
 */
export class TransientRuntime implements Runtime {
	readonly id: string = "transient";
	readonly supports: Record<string, boolean | string> = { inputDuringTurn: true, waitingThroughRestart: false, continuesAfterRestart: false };
	constructor(protected options: TransientRuntimeOptions = {}) {}

	runTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal): Promise<TurnOutcome> {
		return this.withHooks(input, host, signal, (progress) => this.loop(input, host, signal, progress));
	}

	private async withHooks(input: TurnInput, host: RuntimeHost, signal: AbortSignal, run: (progress: TurnProgress) => Promise<TurnExit>, starting = true): Promise<TurnOutcome> {
		const progress: TurnProgress = { entries: [], usage: zeroUsage(), steps: 0, calls: new Map() };
		let exit: TurnExit;
		try {
			if (starting) await host.hook("turn.start", { sessionId: input.sessionId, turnId: input.turnId });
			exit = await run(progress);
		} catch (error) {
			exit = { outcome: { kind: "failed", error: error instanceof Error ? error.message : String(error) } };
		}
		const outcome: Outcome = signal.aborted ? { kind: "cancelled" } : exit.outcome;
		const openToolCalls = outcome.kind === "cancelled" ? [] : [...progress.calls].filter(([, pending]) => pending).map(([id]) => id);
		const result = { ...(exit.text === undefined ? {} : { text: exit.text }), openToolCalls };
		await host.hook("turn.end", { sessionId: input.sessionId, turnId: input.turnId, outcome, result });
		return { outcome, result, entries: progress.entries, usage: progress.usage };
	}

	/** A transient Runtime ends a turn whose process stopped. The host settles abandoned calls. */
	resumeTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome> {
		return this.withHooks(input, host, signal, async (progress) => {
			const history = await host.history();
			const kept = await host.history({ all: true });
			const pending = new Set(pendingToolCalls(history, interrupted.turnId, kept));
			const retrying = new Set(interrupted.calls.map((c) => c.id));
			for (const e of history) {
				if (e.kind !== "response" || e.message?.role !== "assistant") continue;
				for (const part of e.message.content) if (isToolCall(part) && (pending.has(part.id) || retrying.has(part.id))) {
					progress.calls.set(part.id, pending.has(part.id));
				}
			}
			for (const id of pending) progress.calls.set(id, true);
			const turn = history.filter((e) => e.turnId === interrupted.turnId);
			const auxiliary = new Set(turn.filter((e) => e.kind === "modelRequest" && (e.data as { auxiliary?: boolean })?.auxiliary).map((e) => e.stepId));
			const responses = turn.filter((e) => e.kind === "response" && !auxiliary.has(e.stepId));
			progress.usage = responses.reduce((sum, e) => addUsage(sum, e.message?.role === "assistant" ? e.message.usage : e.usage), zeroUsage());
			progress.steps = responses.length;
			return this.recover(input, host, signal, interrupted, progress, turn, responses);
		}, false);
	}

	protected async recover(_input: TurnInput, host: RuntimeHost, _signal: AbortSignal, interrupted: InterruptedTurn, _progress: TurnProgress, turn: HistoryEntry[], _responses: HistoryEntry[]): Promise<TurnExit> {
		if (interrupted.calls.length) throw new Error("The host did not settle interrupted calls");
		const after = await this.resumedGate(host, interrupted, turn);
		return { outcome: { kind: "failed", error: after?.refuse ?? "The process stopped during the turn" } };
	}

	protected async resumedGate(host: RuntimeHost, interrupted: InterruptedTurn, history: HistoryEntry[]) {
		const last = interrupted.lastStep;
		if (!last) return;
		if (last.decision !== undefined) return last.decision;
		const response = history.find((e) => e.kind === "response" && e.turnId === interrupted.turnId && e.stepId === last.stepId)?.message;
		if (response?.role !== "assistant") throw new Error("Missing committed response for resumed step");
		const gate = await host.hook<GateResult<unknown>>("step.after", { stepId: last.stepId, response });
		return gate?.refused === undefined ? null : { refuse: gate.refused };
	}

	/** Run calls left open past an earlier turn, which now have their answers, then carry on. */
	continueOpenCalls(input: TurnInput, host: RuntimeHost, signal: AbortSignal, calls: InterruptedTurn["calls"]): Promise<TurnOutcome> {
		return this.withHooks(input, host, signal, async (progress) => {
			await this.runPending(host, calls, signal, progress);
			if (hasOpenCalls(progress)) return { outcome: { kind: "completed" } };
			return this.loop(input, host, signal, progress);
		});
	}

	/** Run inherited calls through the usual checks. */
	protected async runPending(host: RuntimeHost, calls: InterruptedTurn["calls"], signal: AbortSignal, progress: TurnProgress): Promise<void> {
		for (const c of calls) {
			if (signal.aborted) break;
			const stepId = c.stepId ?? await host.newId();
			const part = { type: "toolCall" as const, id: c.id, name: c.name, arguments: c.input };
			const recorded = await this.runCall(host, part, stepId, signal);
			this.noteCall(progress, c.id, recorded);
		}
	}

	private noteCall(progress: TurnProgress, id: string, recorded: HistoryEntry | undefined): void {
		progress.calls.set(id, !recorded);
		if (recorded) progress.entries.push(recorded.id);
	}

	/** The step loop. It rebuilds the model context from the history on every step, so it can start mid-turn. */
	protected async loop(input: TurnInput, host: RuntimeHost, signal: AbortSignal, progress: TurnProgress): Promise<TurnExit> {
		const maxSteps = input.settings.maxSteps ?? this.options.maxSteps ?? 100;
		const maxRetries = this.options.maxRetries ?? 3;
		const { entries } = progress;
		let retries = 0;
		const done = (outcome: Outcome, last?: AssistantMessage): TurnExit => ({ outcome, text: last ? textOf(last.content) : undefined });
		let last: AssistantMessage | undefined;
		let replacement: ModelRequest | undefined;
		let compacted = false;

		while (true) {
			if (signal.aborted) return done({ kind: "cancelled" }, last);
			for (const e of await host.takeSteering()) entries.push(e.id);

			if (progress.steps >= maxSteps) return done({ kind: "limit", limit: "steps" }, last);
			const stepId = await host.newId();
			host.report("step.started", {}, { stepId });
			let request: ModelRequest;
			let message: AssistantMessage;
			try {
				request = replacement ?? await host.prepareStep({ stepId, usage: progress.usage });
				replacement = undefined;
				message = await input.model.request(request, {
					signal, sessionId: input.sessionId, stepId,
					onEvent: (event) => host.report("model.output", event, { stepId }),
				});
			} catch (error) {
				const e = error as { code?: string; limit?: string; data?: { limit?: string } };
				const limit = e.limit ?? e.data?.limit;
				if (e.code === "turn_limit" && limit) return done({ kind: "limit", limit }, last);
				if (signal.aborted) return done({ kind: "cancelled" }, last);
				throw error;
			}
			last = message;
			entries.push((await host.record({ kind: "response", writer: "runtime", modelVisible: true, stepId, message })).id);
			progress.steps++;
			progress.usage = addUsage(progress.usage, message.usage);

			if (message.stop === "aborted" || signal.aborted) {
				await this.settleUnanswered(host, message, stepId, "cancelled", entries);
				return done({ kind: "cancelled" }, message);
			}
			if (message.stop === "failed") {
				const decision = !compacted && retries < maxRetries ? await host.hook<{ retry: boolean; request?: ModelRequest } | undefined>("model.failed", {
					error: message.error ?? ({ kind: "other", message: "unknown" } as ModelError), attempt: retries, request,
				}) : undefined;
				const after = await host.hook<GateResult<unknown>>("step.after", { stepId, response: message });
				if (signal.aborted) return done({ kind: "cancelled" }, message);
				if (after?.refused !== undefined) return done({ kind: "failed", error: after.refused }, message);
				if (decision?.retry) {
					retries++;
					if (message.error?.kind === "contextTooLarge") compacted = true;
					replacement = decision.request;
					continue;
				}
				return done({ kind: "failed", error: message.error?.message ?? "The model request failed" }, message);
			}

			retries = 0;
			const calls = message.content.filter(isToolCall);
			for (const c of calls) progress.calls.set(c.id, false);
			// Record each result as soon as it is ready. The host orders the model view.
			const definitions = await Promise.all(calls.map((c) => host.definition(c.name)));
			const together = calls.length > 1 && definitions.every((d) => d?.parallel === true);
			if (together) {
				const prepared: Prepared[] = [];
				for (const part of calls) {
					const p = await this.preflight(host, part, stepId);
					if (p.pending) progress.calls.set(part.id, true);
					prepared.push(p);
				}
				// A sibling can still commit a pending disposition after another callback fails.
				const results = await Promise.allSettled(prepared.map(async (p) => {
					const ran = p.refused !== undefined || p.pending ? undefined : await host.runToolCall(p.call, signal);
					const recorded = await this.complete(host, p, stepId, ran);
					this.noteCall(progress, p.call.id, recorded);
				}));
				if (signal.aborted) return done({ kind: "cancelled" }, message);
				const failed = results.find((r) => r.status === "rejected");
				if (failed) throw failed.reason;
			} else {
				for (let i = 0; i < calls.length; i++) {
					const part = calls[i];
					if (signal.aborted) {
						await this.settleUnanswered(host, message, stepId, "cancelled", entries, i);
						return done({ kind: "cancelled" }, message);
					}
					const recorded = await this.runCall(host, part, stepId, signal);
					this.noteCall(progress, part.id, recorded);
				}
			}
			host.report("step.ended", { usage: message.usage }, { stepId });
			// "After each step": a plugin may end the turn.
			const after = await host.hook<GateResult<unknown>>("step.after", { stepId, response: message });
			if (after?.refused !== undefined) return done({ kind: "failed", error: after.refused }, message);
			if (signal.aborted) return done({ kind: "cancelled" }, message);
			if (hasOpenCalls(progress)) {
				if (this.supports.inputDuringTurn) for (const e of await host.takeSteering(true)) entries.push(e.id);
				return done({ kind: "completed" }, message);
			}
			if (progress.steps >= maxSteps) return done({ kind: "limit", limit: "steps" }, message);

			if (calls.length === 0) {
				const taken = this.supports.inputDuringTurn ? await host.takeSteering(true) : [];
				for (const e of taken) entries.push(e.id);
				if (taken.length) continue;
				// "The turn's result is ready": a plugin may send the model back.
				const check = await host.hook<GateResult<unknown>>("turn.result", { result: { text: textOf(message.content) }, shape: input.resultShape });
				if (check?.refused) {
					continue;
				}
				return done({ kind: "completed" }, message);
			}
		}
	}

	protected async runCall(host: RuntimeHost, part: ToolCallPart, stepId: string, signal: AbortSignal): Promise<HistoryEntry | undefined> {
		const prepared = await this.preflight(host, part, stepId);
		const ran = prepared.refused !== undefined || prepared.pending ? undefined : await host.runToolCall(prepared.call, signal);
		return this.complete(host, prepared, stepId, ran);
	}

	/** "Before a tool call": allow, refuse, change or leave open. */
	protected async preflight(host: RuntimeHost, part: ToolCallPart, stepId: string): Promise<Prepared> {
		const call: ToolCall = { id: part.id, name: part.name, input: part.arguments ?? {}, startedBy: "model", stepId };
		const gate = await host.hook<GateResult<{ call: ToolCall }>>("tool.before", { call, definition: await host.definition(call.name) });
		if (gate.pending) return { call, pending: gate.pending };
		if (gate.refused !== undefined) {
			const result = (gate as typeof gate & { result?: ToolResult }).result;
			if (host.hostSettlesTools && (!result || result.callId !== call.id)) throw new Error("Missing committed result for refused call");
			return { call, refused: gate.refused, result };
		}
		return { call: gate.value.call };
	}

	/** "After a tool call", then record its one result. Returns undefined when the call is left open. */
	protected async complete(host: RuntimeHost, prepared: Prepared, stepId: string, ran: Awaited<ReturnType<RuntimeHost["runToolCall"]>> | undefined): Promise<HistoryEntry | undefined> {
		const call = prepared.call;
		if (prepared.pending) return this.leaveOpen(host, call, prepared.pending);
		if (ran && isPending(ran)) return this.leaveOpen(host, call, ran.pending);
		const committed = prepared.result ?? ran as ToolResult | undefined;
		if (host.hostSettlesTools && !committed) throw new Error("Missing committed tool result");
		let result: ToolResult = committed ?? { callId: call.id, status: "refused", content: [text(`Refused: ${prepared.refused}`)] };
		if (host.hostSettlesTools && result.status === "notStarted") throw new Error("The host abandoned the tool call");
		try {
			const after = await host.hook<{ result: ToolResult }>("tool.after", { call, result });
			result = after?.result ?? result;
		} catch (error) {
			// A host may answer `cancelled` once the turn is cancelled. The call still gets its one result, unchanged.
			if ((error as { code?: string })?.code !== "cancelled") throw error;
		}
		host.report("tool.result", { status: result.status }, { stepId, toolCallId: call.id });
		return host.record({
			kind: "toolResult", writer: "runtime", modelVisible: true, stepId, toolCallId: call.id,
			message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" },
			data: { status: result.status, value: result.value, display: result.display },
		});
	}

	/** Left open past this turn. It gets its one result later, when its answer arrives. */
	private leaveOpen(host: RuntimeHost, call: ToolCall, reason: string): undefined {
		host.report("tool.open", { reason }, { stepId: call.stepId, toolCallId: call.id });
		return undefined;
	}

	/** Every tool call ends with exactly one result. */
	private async settleUnanswered(host: RuntimeHost, message: AssistantMessage, stepId: string, status: "cancelled", entries: string[], from = 0) {
		if (host.hostSettlesTools) return;
		const calls = message.content.filter(isToolCall).slice(from);
		for (const part of calls) {
			const e = await host.record({
				kind: "toolResult", writer: "runtime", modelVisible: true, stepId, toolCallId: part.id,
				message: { role: "toolResult", toolCallId: part.id, toolName: part.name, content: [text("Cancelled before it ran")], isError: true },
				data: { status: status === "cancelled" ? "notStarted" : status },
			});
			entries.push(e.id);
		}
	}
}

export function transientRuntime(options?: TransientRuntimeOptions): Plugin {
	return {
		name: "runtime-transient",
		spawn: { module: "@modular-agent/runtime-transient", export: "transientRuntime", options },
		setup(api) {
			api.provide("runtime", new TransientRuntime(options));
		},
	};
}
