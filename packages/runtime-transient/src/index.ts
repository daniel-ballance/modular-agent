import {
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
	isToolCall,
	text,
	textOf,
	zeroUsage,
} from "@modular-agent/harness";

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
		return this.loop(input, host, signal);
	}

	/** A transient Runtime ends a turn whose process stopped. Each pending call gets one result. */
	async resumeTurn(_input: TurnInput, host: RuntimeHost, _signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome> {
		const entries: string[] = [];
		for (const c of interrupted.calls) {
			entries.push((await this.settle(host, c, c.started ? "outcomeUnknown" : "notStarted")).id);
		}
		return { outcome: { kind: "failed", error: "The process stopped during the turn" }, result: { openToolCalls: [] }, entries, usage: zeroUsage() };
	}

	/** Run calls left open past an earlier turn, which now have their answers, then carry on. */
	async continueOpenCalls(input: TurnInput, host: RuntimeHost, signal: AbortSignal, calls: InterruptedTurn["calls"]): Promise<TurnOutcome> {
		const entries: string[] = [];
		const stillOpen = await this.runPending(host, calls, signal, entries, () => true);
		if (stillOpen.length) return { outcome: { kind: "completed" }, result: { openToolCalls: stillOpen }, entries, usage: zeroUsage() };
		return this.loop(input, host, signal, entries);
	}

	/** Run pending calls through the usual checks. Returns the ids of calls that are still open. */
	protected async runPending(host: RuntimeHost, calls: InterruptedTurn["calls"], signal: AbortSignal, entries: string[], mayRun: (c: InterruptedTurn["calls"][number]) => boolean): Promise<string[]> {
		const open: string[] = [];
		for (const c of calls) {
			if (!mayRun(c)) {
				entries.push((await this.settle(host, c, "outcomeUnknown")).id);
				continue;
			}
			const recorded = await this.runCall(host, { type: "toolCall", id: c.id, name: c.name, arguments: c.input }, c.stepId ?? host.newId(), signal);
			if (recorded) entries.push(recorded.id);
			else open.push(c.id);
		}
		return open;
	}

	protected settle(host: RuntimeHost, c: InterruptedTurn["calls"][number], status: "outcomeUnknown" | "notStarted") {
		const note = status === "outcomeUnknown" ? "The process stopped while this tool call was running. Its outcome is unknown." : "The process stopped before this tool call started.";
		return host.record({
			kind: "toolResult", writer: "runtime", modelVisible: true, stepId: c.stepId, toolCallId: c.id,
			message: { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [text(note)], isError: true },
			data: { status },
		});
	}

	/** The step loop. It rebuilds the model context from the history on every step, so it can start mid-turn. */
	protected async loop(input: TurnInput, host: RuntimeHost, signal: AbortSignal, entries: string[] = []): Promise<TurnOutcome> {
		const maxSteps = input.settings.maxSteps ?? this.options.maxSteps ?? 100;
		const maxRetries = this.options.maxRetries ?? 3;
		let usage = zeroUsage();
		let steps = 0;
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

			const stepId = host.newId();
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
				if (decision.request) request = decision.request;
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
			host.report("step.ended", { usage: message.usage }, { stepId });
			steps++;
			// A call left open past this turn has no result, so the model can't be asked again: the turn ends.
			if (open.length) return { ...done({ kind: "completed" }, message), result: { text: textOf(message.content), openToolCalls: open } };

			// "After each step": a plugin may end the turn.
			const after = await host.hook<GateResult<unknown>>("step.after", { stepId, response: message });
			if (after?.refused) return done({ kind: "completed" }, message);
			if (signal.aborted) return done({ kind: "cancelled" }, message);
			if (steps >= maxSteps) return done({ kind: "limit", limit: "steps" }, message);

			if (calls.length === 0) {
				if (host.hasSteering()) continue;
				// "The turn's result is ready": a plugin may send the model back.
				const check = await host.hook<GateResult<unknown>>("turn.result", { result: { text: textOf(message.content) }, shape: input.resultShape });
				if (check?.refused) {
					entries.push((await host.record({ kind: "resultCheck", writer: "runtime", modelVisible: true, message: { role: "user", content: [text(check.refused)] } })).id);
					continue;
				}
				return done({ kind: "completed" }, message);
			}
		}
	}

	protected async runCall(host: RuntimeHost, part: ToolCallPart, stepId: string, signal: AbortSignal): Promise<HistoryEntry | undefined> {
		let call: ToolCall = { id: part.id, name: part.name, input: part.arguments ?? {}, startedBy: "model", stepId };
		const definition = host.definition(call.name);
		const gate = await host.hook<GateResult<{ call: ToolCall }>>("tool.before", { call, definition });
		if (gate.pending) {
			// Left open past this turn. It gets its one result later, when its answer arrives.
			await host.record({ kind: "toolOpen", writer: "runtime", modelVisible: false, stepId, toolCallId: call.id, data: { reason: gate.pending } });
			host.report("tool.open", { reason: gate.pending }, { stepId, toolCallId: call.id });
			return undefined;
		}
		let result: ToolResult;
		if (gate.refused) {
			result = { callId: call.id, status: "refused", content: [text(`Refused: ${gate.refused}`)] };
		} else {
			call = gate.value.call;
			result = await host.runToolCall(call, signal);
		}
		const after = await host.hook<{ result: ToolResult }>("tool.after", { call, result });
		result = after?.result ?? result;
		host.report("tool.result", { status: result.status }, { stepId, toolCallId: call.id });
		return host.record({
			kind: "toolResult", writer: "runtime", modelVisible: true, stepId, toolCallId: call.id,
			message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" },
			data: { status: result.status, value: result.value, display: result.display },
		});
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
		setup(api) {
			api.provide("runtime", new TransientRuntime(options));
		},
	};
}
