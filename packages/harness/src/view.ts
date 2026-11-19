import { type ContentPart, type HistoryEntry, type InterruptedTurn, type ModelMessage, type ResumedStep, type ToolCall, isToolCall, text } from "./types.js";

/** Restore the last real answer and prove whether its gate committed. */
export function restoreAnsweredStep(branch: HistoryEntry[], turnId: string, kept = branch): { lastStep: ResumedStep; response: HistoryEntry } | undefined {
	const attempts = new Map(branch.filter((e) => e.kind === "modelRequest" && e.turnId === turnId).map((e) => [e.stepId, e]));
	const response = branch.findLast((e) => e.kind === "response" && e.turnId === turnId &&
		!(attempts.get(e.stepId)?.data as { auxiliary?: boolean } | undefined)?.auxiliary && !(e.data as { recovery?: boolean } | undefined)?.recovery);
	if (!response) return undefined;
	const stepId = response.stepId;
	const intent = attempts.get(stepId);
	if (!stepId || response.erased || response.message?.role !== "assistant" || !intent || intent.erased) throw new Error("Cannot restore the last answered step");
	const records = kept.filter((e) => e.kind === "modular-agent.stepAfter" && e.turnId === turnId && e.stepId === stepId);
	if (!records.length && (intent.data as { tracksStepAfter?: boolean } | undefined)?.tracksStepAfter === true) return { lastStep: { stepId }, response };
	const record = records[0];
	const decision = (record?.data as { decision?: unknown } | undefined)?.decision;
	if (records.length !== 1 || record.erased || !branch.some((e) => e.id === record.id) ||
		!(decision === null || (typeof decision === "object" && decision && "refuse" in decision && typeof decision.refuse === "string" && Object.keys(decision).length === 1))) {
		throw new Error("Cannot establish the last step's gate decision");
	}
	return { lastStep: { stepId, decision: decision as ResumedStep["decision"] }, response };
}

/** Rebuild pending calls from the standard entry kinds on the current branch. */
export function interruptedCalls(history: HistoryEntry[], turnId: string): InterruptedTurn["calls"] {
	const answered = new Set(history.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
	const inTurn = history.filter((e) => e.turnId === turnId);
	const started = new Map(inTurn.filter((e) => e.kind === "toolStarted").map((e) => [e.toolCallId, e]));
	const calls = new Map<string, InterruptedTurn["calls"][number]>();
	for (const e of inTurn) {
		if (e.kind !== "response" || e.message?.role !== "assistant" || !["toolUse", "finished"].includes(e.message.stop)) continue;
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

/** Committed calls left open by this turn, in their original call order. */
export function pendingToolCalls(branch: HistoryEntry[], turnId: string, kept = branch): string[] {
	const terminal = new Set(kept.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
	const pending = new Set(branch.flatMap((e) => e.kind === "toolPending" && e.turnId === turnId &&
		!e.erased && e.toolCallId && !terminal.has(e.toolCallId) ? [e.toolCallId] : []));
	if (!pending.size) return [];
	const ordered: string[] = [];
	for (const e of branch) {
		if (e.kind !== "response" || e.message?.role !== "assistant") continue;
		for (const part of e.message.content) if (isToolCall(part) && pending.delete(part.id)) ordered.push(part.id);
	}
	return [...ordered, ...pending];
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
