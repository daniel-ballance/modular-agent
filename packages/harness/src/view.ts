import { type ContentPart, type HistoryEntry, type InterruptedTurn, type ModelMessage, type ToolCall, isToolCall, text } from "./types.js";

/** Rebuild pending calls from the standard entry kinds on the current branch. */
export function interruptedCalls(history: HistoryEntry[], turnId: string): InterruptedTurn["calls"] {
	const answered = new Set(history.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
	const inTurn = history.filter((e) => e.turnId === turnId);
	const started = new Map(inTurn.filter((e) => e.kind === "toolStarted").map((e) => [e.toolCallId, e]));
	const calls = new Map<string, InterruptedTurn["calls"][number]>();
	for (const e of inTurn) {
		if (e.kind !== "response" || e.message?.role !== "assistant") continue;
		for (const c of e.message.content.filter(isToolCall)) {
			if (!answered.has(c.id)) calls.set(c.id, { id: c.id, name: c.name, input: c.arguments ?? {}, stepId: e.stepId, started: false, safeToRepeat: false });
		}
	}
	for (const [id, entry] of started) {
		if (!id || answered.has(id)) continue;
		const data = entry.data as { call?: ToolCall; safeToRepeat?: boolean } | undefined;
		const call = data?.call ?? calls.get(id);
		if (call) calls.set(id, { id, name: call.name, input: call.input, stepId: entry.stepId, started: true, safeToRepeat: data?.safeToRepeat === true });
	}
	return [...calls.values()];
}

/** Assemble the branch projection without changing the kept record. */
export function modelView(entries: HistoryEntry[], _turnId?: string): ModelMessage[] {
	const pending = new Set(entries.flatMap((e) => {
		if (e.erased || e.kind !== "turnEnd") return [];
		return (e.data as { result?: { openToolCalls?: string[] } })?.result?.openToolCalls ?? [];
	}));
	const rows: { id: string; message: ModelMessage }[] = [];
	const contexts = new Map<string, HistoryEntry>();
	const byId = new Map(entries.map((e) => [e.id, e]));
	for (const e of entries) {
		if (e.erased || e.kind.includes(".")) continue;
		if (e.kind === "turnStart" && e.turnId && (e.data as { context?: ContentPart[] })?.context?.length) contexts.set(e.turnId, e);
		if (e.kind === "input" && e.turnId) {
			const start = contexts.get(e.turnId);
			if (start) rows.push({ id: start.id, message: { role: "user", content: (start.data as { context: ContentPart[] }).context } });
			contexts.delete(e.turnId);
		}
		if (e.kind === "summary") {
			const data = e.data as { summary?: string; summarizes?: string[] } | undefined;
			const sources = data?.summarizes ?? e.sources ?? [];
			if (typeof data?.summary !== "string" || !sources.length || sources.some((id) => !byId.has(id) || byId.get(id)?.erased)) continue;
			const selected = new Set(sources);
			const at = rows.findIndex((row) => selected.has(row.id));
			if (at < 0) continue;
			for (let i = rows.length - 1; i >= at; i--) if (selected.has(rows[i].id)) rows.splice(i, 1);
			rows.splice(at, 0, { id: e.id, message: { role: "user", content: [text(data.summary)] } });
		}
		if (e.modelVisible && e.message) rows.push({ id: e.id, message: e.message });
	}
	return pairToolResults(rows.map((r) => r.message), pending);
}

export const WAITING_NOTE = "This call is waiting for an answer. It has no result yet.";

/** Results sit immediately after the response that proposed their calls. */
export function pairToolResults(messages: ModelMessage[], pending = new Set<string>()): ModelMessage[] {
	const results = new Map(messages.flatMap((m) => m.role === "toolResult" ? [[m.toolCallId, m] as const] : []));
	const out: ModelMessage[] = [];
	for (const m of messages) {
		if (m.role === "toolResult") continue;
		if (m.role !== "assistant") { out.push(m); continue; }
		const offered = m.stop === "finished" || m.stop === "toolUse";
		const content = m.content.filter((part) => !isToolCall(part) || (offered && (results.has(part.id) || pending.has(part.id))));
		if (!content.length && (m.stop === "failed" || m.stop === "aborted")) continue;
		out.push({ ...m, content });
		for (const call of content.filter(isToolCall)) {
			out.push(results.get(call.id) ?? { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [text(WAITING_NOTE)], isError: true });
		}
	}
	return out;
}
