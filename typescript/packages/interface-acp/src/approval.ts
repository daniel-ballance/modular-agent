import { isDeepStrictEqual } from "node:util";
import type { HistoryEntry, InputRequest, PluginApi } from "@modular-agent/harness";

/** Reconstruct the polling view from the immutable entry, not the saved client response. */
export async function unchangedAcpApproval(api: PluginApi, entry: HistoryEntry, recipient: string) {
	const { request, call } = entry.data as { request: InputRequest; call: { name: string; input: object } };
	const view = { id: request.id, kind: request.kind, question: request.question, toolCallId: entry.toolCallId,
		call: { name: call.name, input: call.input }, ...(request.coversNested ? { coversNested: true } : {}), approvalWait: request.approvalWait, deadlineAt: request.deadlineAt };
	const method = "_modular-agent/requests";
	const reply = await api.gateOutput(entry.sessionId, recipient, "reply", { method, result: { requests: [structuredClone(view)] } });
	return reply?.method === method && isDeepStrictEqual(reply.result.requests, [view]);
}
