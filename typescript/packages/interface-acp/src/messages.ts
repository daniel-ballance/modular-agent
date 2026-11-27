import type * as acp from "@agentclientprotocol/sdk";
import { text, type ContentPart } from "@modular-agent/harness";

/** ACP prompt content, as our content parts. */
export function fromAcp(blocks: acp.ContentBlock[]): ContentPart[] {
	return blocks.map((b): ContentPart => {
		switch (b.type) {
			case "text":
				return text(b.text);
			case "image":
				return { type: "image", data: b.data, mimeType: b.mimeType };
			case "resource": {
				const r = b.resource as { uri: string; text?: string; blob?: string };
				return text(r.text !== undefined ? `<resource uri="${r.uri}">\n${r.text}\n</resource>` : `[resource ${r.uri}]`);
			}
			case "resource_link":
				return text(`[resource link ${b.uri}${b.name ? ` (${b.name})` : ""}]`);
			default:
				// Kept intact in the record, even though the model can't use it.
				return { ...(b as object), type: `acp:${(b as { type: string }).type}` };
		}
	});
}

export interface Outcome { kind: string; error?: string; limit?: string }
export interface Waiter {
	inputId: string;
	turnId?: string;
	duplicate?: boolean;
	resolve(response: acp.PromptResponse): void;
	reject(error: Error): void;
}

/** A turn's outcome as an ACP prompt response, with the binding's _meta. */
export function promptResponse(inputId: string, outcome: Outcome, extra: Record<string, unknown> = {}): acp.PromptResponse {
	const stopReason: acp.StopReason =
		outcome.kind === "cancelled" ? "cancelled" : outcome.kind === "limit" ? (["output", "tenantTokens", "sessionTokens"].includes(outcome.limit ?? "") ? "max_tokens" : "max_turn_requests") : outcome.kind === "failed" ? "refusal" : "end_turn";
	return { stopReason, _meta: { ["modular-agent"]: { inputId, outcome, ...extra } } };
}
