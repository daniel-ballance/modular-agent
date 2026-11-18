import { isDeepStrictEqual } from "node:util";
import type { AgentEvent } from "@modular-agent/harness";
import { WireError } from "./wire.js";

type WireEvent = { type: string; data: any };
export interface MappedOutput {
	wire: WireEvent;
	restore(event: WireEvent): AgentEvent;
}

/** Give a remote gate the shared vocabulary without exposing the host's envelope. */
export function mapOutput(event: AgentEvent): MappedOutput {
	const { type, data, stepId, toolCallId, turnId } = event;
	const mapped = (type: string, value: unknown, from: (data: any) => Partial<AgentEvent>): MappedOutput => {
		const wire = JSON.parse(JSON.stringify({ type, data: value ?? null })) as WireEvent;
		return {
			wire,
			restore(answer) {
				if (answer?.type !== type || !sameShape(wire.data, answer.data)) throw new WireError("invalid_request", "Cannot map the changed output event");
				return isDeepStrictEqual(wire.data, answer.data) ? event : { ...event, ...from(answer.data) };
			},
		};
	};
	if (type === "model.output" && ["text", "reasoning"].includes(data?.type)) {
		return mapped(data.type, { delta: data.delta, stepId }, (d) => ({ data: { ...data, delta: d.delta }, stepId: d.stepId }));
	}
	if (type === "tool.started") return mapped("toolCall", { call: data.call }, (d) => ({ data: { ...data, call: d.call }, toolCallId: d.call.id }));
	if (type === "tool.progress" && data?.content?.length === 1 && data.content[0].type === "text") {
		return mapped("toolOutput", { toolCallId, chunk: data.content[0].text }, (d) => ({ toolCallId: d.toolCallId, data: { content: [{ ...data.content[0], text: d.chunk }] } }));
	}
	if (type === "tool.result.delivered") return mapped("toolResult", { toolCallId, ...data }, (d) => {
		const { toolCallId, ...result } = d;
		return { toolCallId, data: result };
	});
	if (type === "entry" || type === "entry.added") return mapped("entry", { entry: data }, (d) => ({ data: d.entry }));
	if (type === "turn.ended") return mapped("turnEnded", { turnId, outcome: data.outcome, result: data.result }, (d) => ({ turnId: d.turnId, data: { ...data, outcome: d.outcome, result: d.result } }));
	if (type === "reply" || type === "request") return mapped(type, data, (d) => ({ data: d }));
	return mapped(type.includes(".") ? type : `typescript.${type}`, data, (d) => ({ data: d }));
}

/** A gate may redact strings, but cannot change types, order or non-string values. */
function sameShape(before: unknown, after: unknown, protectedValue = false): boolean {
	if (protectedValue) return isDeepStrictEqual(before, after);
	if (typeof before === "string") return typeof after === "string";
	if (Array.isArray(before)) return Array.isArray(after) && before.length === after.length && before.every((value, i) => sameShape(value, after[i]));
	if (before && typeof before === "object") {
		if (!after || typeof after !== "object" || Array.isArray(after)) return false;
		const left = Object.keys(before);
		const right = Object.keys(after);
		return left.length === right.length && left.every((key) => Object.hasOwn(after, key) &&
			sameShape((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], /^(type|kind|status|method|stop|id|rights|rawInput|key|optionId|credential|nextEntryId)$|Ids?$/.test(key)));
	}
	return before === after;
}
