import { isToolCall, textOf, type HistoryEntry, type InterruptedTurn, type Plugin, type RuntimeHost, type TurnInput } from "@modular-agent/harness";
import { TransientRuntime, type TransientRuntimeOptions, type TurnProgress } from "@modular-agent/runtime-transient";

/**
 * A durable Runtime: a turn carries on after its process stops and starts again.
 *
 * It keeps no store of its own. Everything it needs is already in the session's
 * history, which records each step's response and each tool call as it starts
 * and ends, and the step loop rebuilds the model context from that history.
 * So after a restart it settles the pending tool calls and continues the loop.
 *
 * A pending call that never started is run. One that started is run again only
 * if the tool and environment promised it was safe to repeat; otherwise its outcome is unknown, and
 * the model is told so. Every call still passes the "before a tool call" hook
 * point, so a late approval is checked again.
 *
 * Questions survive too. The Harness records each question and answer, and a
 * pending call's checks run again with the same keys, so an open question is
 * reopened and an answered one is not asked twice.
 */
export class DurableRuntime extends TransientRuntime {
	override readonly id = "durable";
	override readonly supports = { inputDuringTurn: true, waitingThroughRestart: true, continuesAfterRestart: true, nestedToolCalls: true, interfaceTools: true,
		queuedInputAfterRestart: "handedBack", queuedJobReportsAfterRestart: "run" };

	protected override async recover(input: TurnInput, host: RuntimeHost, signal: AbortSignal, interrupted: InterruptedTurn, progress: TurnProgress, turn: HistoryEntry[], responses: HistoryEntry[]): ReturnType<TransientRuntime["recover"]> {
		const calls = interrupted.calls;
		if (calls.some((c) => c.started && !c.safeToRepeat)) throw new Error("The host passed an ineligible interrupted call");
		const committedRefusal = interrupted.lastStep?.decision?.refuse;
		if (committedRefusal !== undefined) return { outcome: { kind: "failed", error: committedRefusal } };
		host.report("turn.resumed", { pending: calls.length });
		await this.runPending(host, calls, signal, progress);
		const after = await this.resumedGate(host, interrupted, turn);
		if (after) return { outcome: { kind: "failed", error: after.refuse } };
		if ([...progress.calls.values()].some(Boolean)) return { outcome: { kind: "completed" } };
		const inFlight = turn.filter((e) => e.kind === "modelRequest" && !e.erased && !responses.some((r) => r.stepId === e.stepId));
		if (!signal.aborted && inFlight.some((e) => (e.data as { safeToRepeat?: boolean }).safeToRepeat !== true ||
			!(input.model.supports.safeToRepeat === true || (input.model.supports.keepsState === false && input.model.supports.runsTools === false)))) {
			return { outcome: { kind: "failed", error: "An interrupted model request may have had an effect" } };
		}
		const lastEntry = responses.find((e) => e.stepId === interrupted.lastStep?.stepId);
		const last = lastEntry?.message;
		const laterInput = lastEntry && turn.slice(turn.indexOf(lastEntry) + 1).some((e) => !e.erased && (e.message?.role === "user" || e.kind === "resultFeedback"));
		if (!signal.aborted && !inFlight.length && last?.role === "assistant" && !laterInput && !last.content.some(isToolCall)) {
			const text = textOf(last.content);
			if (last.stop === "failed") return { outcome: { kind: "failed", error: last.error?.message ?? "The model request failed" }, text };
			if (last.stop === "aborted") return { outcome: { kind: "cancelled" }, text };
			return { outcome: { kind: "completed" }, text };
		}
		return this.loop(input, host, signal, progress);
	}
}

export function durableRuntime(options?: TransientRuntimeOptions): Plugin {
	return {
		name: "runtime-durable",
		spawn: { module: "@modular-agent/runtime-durable", export: "durableRuntime", options },
		replaces: "runtime-transient",
		setup(api) {
			api.provide("runtime", new DurableRuntime(options));
		},
	};
}
