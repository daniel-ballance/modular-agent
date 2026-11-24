import { isDeepStrictEqual } from "node:util";
import { isToolCall, type Answer, type Authority, type HistoryEntry, type InputRequest, type ToolCall, type ToolDefinition, type TurnOutcome } from "./types.js";
import type { Session } from "./session.js";

export type ApprovalBinding = { call: ToolCall; source: { plugin: string; toolSource: string }; definition: ToolDefinition };
export interface ApprovalProof { requestEntryId: string; submittedBy: string; routeId: string; rights: Authority[] }
/** Operator route policy. It can check a decision again without a live connection. */
export interface ApprovalRoute {
	id: string;
	ceiling(sessionId: string, actorId: string, submittedBy: string): readonly Authority[];
	unchanged(entry: HistoryEntry, actorId: string): Promise<boolean>;
}
export interface ApprovalDelivery {
	routeId: string; actorId: string; submittedBy: string; handle: object; present(): boolean;
}
export interface WaitingApproval {
	entry: HistoryEntry; request: InputRequest; binding: ApprovalBinding; intact: boolean;
	end?: HistoryEntry; decision?: HistoryEntry; proof?: ApprovalProof; start?: HistoryEntry; result?: HistoryEntry;
}
export function sameJson(a: unknown, b: unknown): boolean {
	if (a === undefined || b === undefined) return a === b;
	return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}
export function waitingApprovals(s: Session): Map<string, WaitingApproval> {
	const waits = new Map<string, WaitingApproval>();
	if (!s.hasWaitingApprovals) return waits;
	const branch = s.branch().filter(e => !s.copied.has(e.id));
	const visible = new Set(branch.map(e => e.id));
	const own = s.order.map(id => s.entries.get(id)!).filter(e => !s.copied.has(e.id));
	for (const [i, entry] of branch.entries()) {
		const data = entry.data as (ApprovalBinding & { request?: InputRequest & { answerable?: boolean } }) | undefined;
		const r = data?.request, id = entry.toolCallId;
		if (!id || entry.erased || entry.kind !== "inputRequest" || !r || r.approvalWait !== "untilDeadline") continue;
		const request = { ...r, sessionId: s.id, turnId: entry.turnId, toolCallId: id, answerers: r.answerers ?? [] };
		const pending = branch[i + 1];
		const cp = pending?.data as { requestIds?: string[]; toolStartedId?: string } | undefined;
		const response = branch.find(e => entry.sources?.includes(e.id) && e.kind === "response" && !e.erased && e.turnId === entry.turnId && e.stepId === entry.stepId);
		const offer = branch.find(e => e.kind === "modelRequest" && !e.erased && e.turnId === entry.turnId && e.stepId === entry.stepId);
		const decisions = own.filter(e => e.kind === "inputAnswer" && e.requestId === r.id);
		const decision = decisions[0], answer = decision?.data as (Answer & { approvalView?: ApprovalProof }) | undefined;
		const proof = answer?.approvalView;
		const end = branch.find(e => e.kind === "turnEnd" && !e.erased && e.turnId === entry.turnId && (e.data as TurnOutcome)?.outcome?.kind === "completed" && (e.data as TurnOutcome)?.result?.openToolCalls?.includes(id));
		const intact = !waits.has(id) && !!entry.turnId && !!entry.stepId && entry.requestId === r.id && r.sessionId === s.id && r.toolCallId === id &&
			r.kind === "approval" && r.answerable === false && r.whenTimeLimit === "decline" && Number.isSafeInteger(r.timeLimitMs) && r.timeLimitMs! >= 0 && Number.isSafeInteger(r.deadlineAt) && r.deadlineAt === entry.time + r.timeLimitMs! &&
			data.call?.id === id && data.call.startedBy === "model" && !data.call.parentCallId && data.call.stepId === entry.stepId && data.definition?.name === data.call.name && !!data.source?.plugin && !!data.source.toolSource &&
			response?.message?.role === "assistant" && response.message.content.some(p => isToolCall(p) && p.id === id && p.name === data.call.name) &&
			(offer?.data as { tools?: string[] })?.tools?.includes(data.call.name) === true &&
			pending?.kind === "toolPending" && !pending.erased && pending.parentId === entry.id && pending.turnId === entry.turnId && pending.stepId === entry.stepId && pending.toolCallId === id && sameJson(cp?.requestIds, [r.id]) && cp?.toolStartedId === undefined;
		waits.set(id, { entry, request, binding: data, intact, end, decision,
			proof: decisions.length === 1 && decision && visible.has(decision.id) && !decision.erased && decision.sources?.includes(entry.id) && decision.toolCallId === id && decision.actorId === answer?.actorId && answer?.requestId === r.id && answer.value === "allow" && !answer.declined && proof?.requestEntryId === entry.id && Array.isArray(proof.rights) ? proof : undefined,
			start: own.find(e => e.kind === "toolStarted" && e.toolCallId === id), result: own.find(e => e.kind === "toolResult" && e.toolCallId === id) });
	}
	return waits;
}
