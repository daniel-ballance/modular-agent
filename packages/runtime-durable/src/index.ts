import type { InterruptedTurn, Plugin, RuntimeHost, TurnInput, TurnOutcome } from "@modular-agent/harness";
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
 * if its tool declares it safe to repeat; otherwise its outcome is unknown, and
 * the model is told so. Every call still passes the "before a tool call" hook
 * point, so a late approval is checked again.
 *
 * Questions survive too. The Harness records each question and answer, and a
 * pending call's checks run again with the same keys, so an open question is
 * reopened and an answered one is not asked twice.
 */
export class DurableRuntime extends TransientRuntime {
	override readonly id = "durable";
	override readonly supports = { inputDuringTurn: true, waitingThroughRestart: true, continuesAfterRestart: true, rewinding: false };

	override async resumeTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome> {
		const entries: string[] = [];
		host.report("turn.resumed", { pending: interrupted.calls.length });
		for (const c of interrupted.calls) {
			const safe = host.definition(c.name)?.hints?.idempotent === true;
			if (c.started && !safe) {
				entries.push((await this.settle(host, c, "outcomeUnknown")).id);
				continue;
			}
			const part = { type: "toolCall" as const, id: c.id, name: c.name, arguments: c.input };
			entries.push((await this.runCall(host, part, c.stepId ?? host.newId(), signal)).id);
		}
		return this.loop(input, host, signal, entries);
	}
}

export function durableRuntime(options?: TransientRuntimeOptions): Plugin {
	return {
		name: "runtime-durable",
		replaces: "runtime-transient",
		setup(api) {
			api.provide("runtime", new DurableRuntime(options));
		},
	};
}
