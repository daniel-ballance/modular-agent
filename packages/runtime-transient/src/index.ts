import {
	interruptedNote,
	type AssistantMessage,
	type GateResult,
	type HistoryEntry,
	type InterruptedTurn,
	type ModelError,
	type ModelRequest,
	type Plugin,
	type Runtime,
	type RuntimeHost,
	type ToolCall,
	type ToolCallPart,
	type ToolResult,
	type TurnInput,
	type TurnOutcome,
	addUsage,
	isPending,
	isToolCall,
	text,
	textOf,
	zeroUsage,
} from "@modular-agent/harness";

interface Prepared { call: ToolCall; refused?: string; pending?: string }

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
	readonly supports: Record<string, boolean | string> = { inputDuringTurn: true, waitingThroughRestart: false, continuesAfterRestart: false, rewinding: false };
	constructor(protected options: TransientRuntimeOptions = {}) {}

	runTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal): Promise<TurnOutcome> {
		return this.withHooks(input, host, () => this.loop(input, host, signal), true, signal);
	}

	protected async withHooks(input: TurnInput, host: RuntimeHost, run: () => Promise<TurnOutcome>, starting = true, signal?: AbortSignal): Promise<TurnOutcome> {
		let outcome: TurnOutcome;
		try {
			if (starting) await host.hook("turn.start", { sessionId: input.sessionId, turnId: input.turnId });
			outcome = await run();
		} catch (error) {
			// A cancelled turn ends as cancelled, whatever errors the cancelling caused, such as a host answering `cancelled`.
			outcome = signal?.aborted
				? { outcome: { kind: "cancelled" }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() }
				: { outcome: { kind: "failed", error: error instanceof Error ? error.message : String(error) }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
		}
		// The shared shape (docs/bindings/plugin.md): outcome as on a turnEnd entry, and the result beside it.
		await host.hook("turn.end", { sessionId: input.sessionId, turnId: input.turnId, outcome: outcome.outcome, result: outcome.result });
		return outcome;
	}

	/** A transient Runtime ends a turn whose process stopped. Each pending call gets one result. */
	resumeTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome> {
		return this.withHooks(input, host, () => this.recover(input, host, signal, interrupted), false, signal);
	}

	protected async recover(_input: TurnInput, host: RuntimeHost, _signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome> {
		const entries: string[] = [];
		for (const c of interrupted.calls) {
			entries.push((await this.settle(host, c, c.started ? "outcomeUnknown" : "notStarted")).id);
		}
		return { outcome: { kind: "failed", error: "The process stopped during the turn" }, result: { openToolCalls: [] }, entries, usage: zeroUsage() };
	}

	/** Run calls left open past an earlier turn, which now have their answers, then carry on. */
	continueOpenCalls(input: TurnInput, host: RuntimeHost, signal: AbortSignal, calls: InterruptedTurn["calls"]): Promise<TurnOutcome> {
		return this.withHooks(input, host, () => this.continueCalls(input, host, signal, calls), true, signal);
	}

	private async continueCalls(input: TurnInput, host: RuntimeHost, signal: AbortSignal, calls: InterruptedTurn["calls"]): Promise<TurnOutcome> {
		const entries: string[] = [];
		const stillOpen = await this.runPending(host, calls, signal, entries, () => true);
		if (stillOpen.length) return { outcome: { kind: "completed" }, result: { openToolCalls: stillOpen }, entries, usage: zeroUsage() };
		return this.loop(input, host, signal, entries);
	}

	/** Run pending calls through the usual checks. Returns the ids of calls that are still open. */
	protected async runPending(host: RuntimeHost, calls: InterruptedTurn["calls"], signal: AbortSignal, entries: string[], mayRun: (c: InterruptedTurn["calls"][number]) => boolean | Promise<boolean>): Promise<string[]> {
		const open: string[] = [];
		for (const c of calls) {
			if (!(await mayRun(c))) {
				entries.push((await this.settle(host, c, "outcomeUnknown")).id);
				continue;
			}
			if (signal.aborted) {
				entries.push((await this.settle(host, c, c.started ? "outcomeUnknown" : "notStarted")).id);
				continue;
			}
			const recorded = await this.runCall(host, { type: "toolCall", id: c.id, name: c.name, arguments: c.input }, c.stepId ?? (await host.newId()), signal);
			if (recorded) entries.push(recorded.id);
			else open.push(c.id);
		}
		return open;
	}

	protected settle(host: RuntimeHost, c: InterruptedTurn["calls"][number], status: "outcomeUnknown" | "notStarted") {
		const note = interruptedNote(status === "outcomeUnknown");
		return host.record({
			kind: "toolResult", writer: "runtime", modelVisible: true, stepId: c.stepId, toolCallId: c.id,
			message: { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [text(note)], isError: true },
			data: { status },
		});
	}

	/** The step loop. It rebuilds the model context from the history on every step, so it can start mid-turn. */
	protected async loop(input: TurnInput, host: RuntimeHost, signal: AbortSignal, entries: string[] = [], progress = { usage: zeroUsage(), steps: 0 }): Promise<TurnOutcome> {
		const maxSteps = input.settings.maxSteps ?? this.options.maxSteps ?? 100;
		const maxRetries = this.options.maxRetries ?? 3;
		let { usage, steps } = progress;
		let retries = 0;
		const done = (outcome: TurnOutcome["outcome"], last?: AssistantMessage): TurnOutcome => ({
			outcome,
			result: { text: last ? textOf(last.content) : undefined, openToolCalls: [] },
			entries,
			usage,
		});
		let last: AssistantMessage | undefined;

		while (true) {
			if (signal.aborted) return done({ kind: "cancelled" }, last);
			for (const e of await host.takeSteering()) entries.push(e.id);

			if (steps >= maxSteps) return done({ kind: "limit", limit: "steps" }, last);
			const stepId = await host.newId();
			host.report("step.started", {}, { stepId });
			let request: ModelRequest = await host.prepareStep({ stepId, usage });
			let message: AssistantMessage;
			while (true) {
				message = await input.model.request(request, {
					signal,
					sessionId: input.sessionId,
					onEvent: (event) => host.report("model.output", event, { stepId }),
				});
				if (message.stop !== "failed" || signal.aborted) break;
				// "A model request failed": a plugin may ask for a retry, perhaps after changing the request.
				const decision = await host.hook<{ retry: boolean; request?: ModelRequest } | undefined>("model.failed", {
					stepId, error: message.error ?? ({ kind: "other", message: "unknown" } as ModelError), attempt: retries, request,
				});
				if (!decision?.retry || retries >= maxRetries) break;
				retries++;
				host.report("model.retry", { attempt: retries, error: message.error }, { stepId });
				request = decision.request ?? await host.prepareStep({ stepId, usage });
			}
			retries = 0;
			usage = addUsage(usage, message.usage);
			last = message;
			entries.push((await host.record({ kind: "response", writer: "runtime", modelVisible: true, stepId, message })).id);

			if (message.stop === "aborted" || signal.aborted) {
				await this.settleUnanswered(host, message, stepId, "cancelled", entries);
				return done({ kind: "cancelled" }, message);
			}
			if (message.stop === "failed") {
				return done({ kind: "failed", error: message.error?.message ?? "The model request failed" }, message);
			}

			const calls = message.content.filter(isToolCall);
			const open: string[] = [];
			// Record each result as soon as it is ready. The host orders the model view.
			const definitions = await Promise.all(calls.map((c) => host.definition(c.name)));
			const together = calls.length > 1 && definitions.every((d) => d?.parallel === true);
			if (together) {
				const prepared: Prepared[] = [];
				for (const part of calls) prepared.push(await this.preflight(host, part, stepId));
				await Promise.all(prepared.map(async (p) => {
					const ran = p.refused || p.pending ? undefined : await host.runToolCall(p.call, signal);
					const recorded = await this.complete(host, p, stepId, ran);
					if (recorded) entries.push(recorded.id);
					else open.push(p.call.id);
				}));
				if (signal.aborted) return done({ kind: "cancelled" }, message);
			} else {
				for (let i = 0; i < calls.length; i++) {
					const part = calls[i];
					if (signal.aborted) {
						await this.settleUnanswered(host, message, stepId, "cancelled", entries, i);
						return done({ kind: "cancelled" }, message);
					}
					const recorded = await this.runCall(host, part, stepId, signal);
					if (recorded) entries.push(recorded.id);
					else open.push(part.id);
				}
			}
			host.report("step.ended", { usage: message.usage }, { stepId });
			steps++;
			// A call left open past this turn has no result, so the model can't be asked again: the turn ends.
			if (open.length) return { ...done({ kind: "completed" }, message), result: { text: textOf(message.content), openToolCalls: open } };

			// "After each step": a plugin may end the turn.
			const after = await host.hook<GateResult<unknown>>("step.after", { stepId, response: message });
			if (after?.refused) return done({ kind: "failed", error: after.refused }, message);
			if (signal.aborted) return done({ kind: "cancelled" }, message);
			if (steps >= maxSteps) return done({ kind: "limit", limit: "steps" }, message);

			if (calls.length === 0) {
				if (await host.hasSteering()) continue;
				// "The turn's result is ready": a plugin may send the model back.
				const check = await host.hook<GateResult<unknown>>("turn.result", { result: { text: textOf(message.content) }, shape: input.resultShape });
				if (check?.refused) {
					entries.push((await host.record({ kind: "runtime.resultCheck", writer: "runtime", modelVisible: true, message: { role: "user", content: [text(check.refused)] } })).id);
					continue;
				}
				return done({ kind: "completed" }, message);
			}
		}
	}

	protected async runCall(host: RuntimeHost, part: ToolCallPart, stepId: string, signal: AbortSignal): Promise<HistoryEntry | undefined> {
		const prepared = await this.preflight(host, part, stepId);
		const ran = prepared.refused || prepared.pending ? undefined : await host.runToolCall(prepared.call, signal);
		return this.complete(host, prepared, stepId, ran);
	}

	/** "Before a tool call": allow, refuse, change or leave open. */
	protected async preflight(host: RuntimeHost, part: ToolCallPart, stepId: string): Promise<Prepared> {
		const call: ToolCall = { id: part.id, name: part.name, input: part.arguments ?? {}, startedBy: "model", stepId };
		const gate = await host.hook<GateResult<{ call: ToolCall }>>("tool.before", { call, definition: await host.definition(call.name) });
		if (gate.pending) return { call, pending: gate.pending };
		if (gate.refused) return { call, refused: gate.refused };
		return { call: gate.value.call };
	}

	/** "After a tool call", then record its one result. Returns undefined when the call is left open. */
	protected async complete(host: RuntimeHost, prepared: Prepared, stepId: string, ran: Awaited<ReturnType<RuntimeHost["runToolCall"]>> | undefined): Promise<HistoryEntry | undefined> {
		const call = prepared.call;
		if (prepared.pending) return this.leaveOpen(host, call, prepared.pending);
		if (ran && isPending(ran)) return this.leaveOpen(host, call, ran.pending);
		let result: ToolResult = prepared.refused || !ran ? { callId: call.id, status: "refused", content: [text(`Refused: ${prepared.refused}`)] } : (ran as ToolResult);
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
