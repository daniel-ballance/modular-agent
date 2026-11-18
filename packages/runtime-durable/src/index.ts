import { addUsage, interruptedCalls, isToolCall, textOf, type InterruptedTurn, type Plugin, type RuntimeHost, type TurnInput, type TurnOutcome, zeroUsage } from "@modular-agent/harness";
import { TransientRuntime, type TransientRuntimeOptions } from "@modular-agent/runtime-transient";

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
	override readonly supports = { inputDuringTurn: true, waitingThroughRestart: true, continuesAfterRestart: true };

	protected override async recover(input: TurnInput, host: RuntimeHost, signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome> {
		const history = await host.history();
		const turn = history.filter((e) => e.turnId === interrupted.turnId);
		const responses = turn.filter((e) => e.kind === "response");
		const usage = responses.reduce((sum, e) => addUsage(sum, e.message?.role === "assistant" ? e.message.usage : undefined), zeroUsage());
		const fromHistory = interruptedCalls(history, interrupted.turnId);
		const fromOpenTurn = input.startedBy.kind === "answer" ? interrupted.calls.filter((c) => !fromHistory.some((known) => c.id === known.id)) : [];
		const calls = [...fromOpenTurn, ...fromHistory].map((c) => ({
			...c,
			safeToRepeat: c.safeToRepeat && interrupted.calls.some((sent) => sent.id === c.id && sent.safeToRepeat),
		}));
		const entries: string[] = [];
		host.report("turn.resumed", { pending: calls.length });
		const open = await this.runPending(host, calls, signal, entries, (c) => !c.started || c.safeToRepeat);
		if (open.length) return { outcome: { kind: "completed" }, result: { openToolCalls: open }, entries, usage };
		const inFlight = turn.filter((e) => e.kind === "modelRequest" && !e.erased && !responses.some((r) => r.stepId === e.stepId));
		if (!signal.aborted && inFlight.some((e) => (e.data as { safeToRepeat?: boolean }).safeToRepeat !== true ||
			!(input.model.supports.safeToRepeat === true || (input.model.supports.keepsState === false && input.model.supports.runsTools === false)))) {
			return { outcome: { kind: "failed", error: "An interrupted model request may have had an effect" }, result: { openToolCalls: [] }, entries, usage };
		}
		const lastEntry = responses.at(-1);
		const last = lastEntry?.message;
		const laterInput = lastEntry && turn.slice(turn.indexOf(lastEntry) + 1).some((e) => !e.erased && (e.message?.role === "user" || e.kind === "resultFeedback"));
		if (!signal.aborted && !inFlight.length && last?.role === "assistant" && !laterInput && !last.content.some(isToolCall)) {
			const result = { text: textOf(last.content), openToolCalls: [] };
			if (last.stop === "failed") return { outcome: { kind: "failed", error: last.error?.message ?? "The model request failed" }, result, entries, usage };
			if (last.stop === "aborted") return { outcome: { kind: "cancelled" }, result, entries, usage };
			return { outcome: { kind: "completed" }, result, entries, usage };
		}
		return this.loop(input, host, signal, entries, { usage, steps: responses.length });
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
