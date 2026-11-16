import { type ModelMessage, isToolCall, text } from "./types.js";

export const WAITING_NOTE = "No result yet: this tool call is waiting for an answer. Its result will arrive later.";

/**
 * Models need each tool call followed by its result. When a call is still
 * open, or its result arrived after other input, this puts a stand-in result
 * in the call's place and shows the real result later as a late result.
 * It changes only the view: the record is untouched.
 */
export function pairToolResults(messages: ModelMessage[]): ModelMessage[] {
	const out: ModelMessage[] = [];
	const placed = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "toolResult") {
			if (placed.has(m.toolCallId)) continue;
			out.push(late(m));
			continue;
		}
		out.push(m);
		if (m.role !== "assistant") continue;
		const direct = new Map<string, ModelMessage>();
		let j = i + 1;
		while (j < messages.length && messages[j].role === "toolResult") {
			const r = messages[j] as Extract<ModelMessage, { role: "toolResult" }>;
			direct.set(r.toolCallId, r);
			j++;
		}
		const calls = m.content.filter(isToolCall);
		for (const call of calls) {
			const result = direct.get(call.id);
			if (result) {
				out.push(result);
				placed.add(call.id);
			} else {
				out.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [text(WAITING_NOTE)], isError: false });
			}
		}
		// Results directly after the call that belong to no call in it are kept as late results.
		for (const [id, r] of direct) if (!calls.some((c) => c.id === id)) out.push(late(r as Extract<ModelMessage, { role: "toolResult" }>));
		i = j - 1;
	}
	return out;
}

function late(m: Extract<ModelMessage, { role: "toolResult" }>): ModelMessage {
	return { role: "user", content: [text(`[Late result of the ${m.toolName} tool call ${m.toolCallId}]`), ...m.content] };
}
